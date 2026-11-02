// Pure helpers for the log viewer: matching, level heuristics, line rendering.
import { memo, ReactNode } from 'react';

export type Level = '' | 'err' | 'warn';

export interface Matcher {
  /** Global regex for highlighting. */
  g: RegExp;
  /** Non-global regex for testing (no lastIndex state). */
  t: RegExp;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Longest search accepted (regex or plain). Bounds the cost of every test over up to 20k lines. */
export const MAX_QUERY = 200;

/**
 * Patterns that can backtrack catastrophically (exponential time on a non-matching line), which would
 * freeze the UI: a quantified group that itself contains a quantifier or an alternation, e.g. (a+)+, (\w*)*, (a|aa){2,}.
 * Also back-references, which make matching NP-hard. Conservative on purpose.
 */
const NESTED_QUANT = /\((?:[^()\\]|\\.)*[+*}|](?:[^()\\]|\\.)*\)\s*[+*{]|\\[1-9]/;
/** Unbounded wildcards (.*, \S+, [^x]*): three or more in a row make matching polynomial-heavy on long lines. */
const WILDCARD = /(?:\.|\\[sSwWdD]|\[[^\]]*\])[*+]/g;

export function buildMatcher(query: string, regex: boolean): { matcher: Matcher | null; error: string | null } {
  if (!query) return { matcher: null, error: null };
  if (query.length > MAX_QUERY) return { matcher: null, error: `busca longa demais (máx. ${MAX_QUERY} caracteres)` };
  if (regex && (NESTED_QUANT.test(query) || (query.match(WILDCARD)?.length ?? 0) > 2)) {
    return { matcher: null, error: 'padrão arriscado (quantificador sobre grupo com +, * ou |, referências como \\1, ou muitos .*): pode travar a busca' };
  }
  const src = regex ? query : escapeRe(query);
  try {
    return { matcher: { g: new RegExp(src, 'gi'), t: new RegExp(src, 'i') }, error: null };
  } catch (e) {
    return { matcher: null, error: e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : String(e) };
  }
}

// docker daemon (logfmt) / JSON loggers carry an explicit level: trust it over keywords in the message.
const KV_LEVEL = /\blevel=["']?(\w+)|"level"\s*:\s*"(\w+)"/i;
const ERR_RE = /\b(error|errors|err|fail|failed|failure|fatal|panic|oops|critical|crit|emerg|alert|segfault|exception|traceback|denied)\b|BUG:|Call trace|Unable to handle kernel|Internal error|-ERROR-/i;
const WARN_RE = /\b(warn|warning|warnings|deprecated|timed out|timeout|retrying|blocked for more than)\b/i;

export function levelOf(line: string): Level {
  const kv = KV_LEVEL.exec(line);
  if (kv) {
    const l = (kv[1] || kv[2]).toLowerCase();
    if (/^(err|error|fatal|panic|crit|critical|emerg|alert)$/.test(l)) return 'err';
    if (/^warn/.test(l)) return 'warn';
    return '';
  }
  if (ERR_RE.test(line)) return 'err';
  if (WARN_RE.test(line)) return 'warn';
  return '';
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;
export const cleanLine = (s: string) => (s.includes('\x1b') || s.includes('\r') ? s.replace(ANSI, '') : s);

function highlight(text: string, re: RegExp): ReactNode {
  re.lastIndex = 0;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') {
      re.lastIndex++;
      if (re.lastIndex > text.length) break;
      continue;
    }
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<mark key={k++}>{m[0]}</mark>);
    last = m.index + m[0].length;
  }
  if (!out.length) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export interface Entry { n: number; text: string; level: Level; hit: boolean }

// Primitive props so memo() skips unchanged lines even when the Entry objects are rebuilt.
export const LogLine = memo(function LogLine({ n, text, level, hit, re, showLn }: {
  n: number; text: string; level: Level; hit: boolean; re: RegExp | null; showLn: boolean;
}) {
  const cls = `log-line${level ? ` ${level}` : ''}${hit && re ? ' hit' : ''}`;
  const body = text === '' ? ' ' : re && hit ? highlight(text, re) : text;
  if (!showLn) return <div className={cls}>{body}</div>;
  return (
    <div className={`${cls} with-ln`}>
      <span className="ll-n">{n + 1}</span>
      <span className="ll-t">{body}</span>
    </div>
  );
});
