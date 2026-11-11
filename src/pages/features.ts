// What the Echo's echo-penguin can do among the features added in v0.3.0 (gradual wake, night clock,
// weather, speech, sleep diary), detected from the files on the unit like alarms.ts detects the alarm
// format, so the pages keep working with older images. This covers the programs those features need;
// settings-only ones (gradual wake, night clock) are detected from their keys in defaults.conf.
// v0.3.1 adds Piper, a natural (neural, offline) voice for the alarm's greeting. After v0.3.1 Piper is
// the only voice (espeak-ng's is gone): the clock's tap is said from clips rendered ahead.

export const NEEDS_V030 = 'requer echo-penguin v0.3.0';
export const NEEDS_V031 = 'requer echo-penguin v0.3.1';

export interface Features {
  /** /usr/local/sbin/penguin-weather */
  weather: boolean;
  /** /usr/local/sbin/penguin-sleep */
  sleep: boolean;
  /** penguin-sound has the `say` subcommand. */
  say: boolean;
  /** espeak-ng is installed (`say` needs it). */
  espeak: boolean;
  /** Piper, the offline neural voice (/usr/local/bin/piper), v0.3.1+. Its settings need SPEAK_ENGINE in defaults.conf too. */
  piper: boolean;
  /** penguin-sound speaks from Piper clips (`say --ready`, `prepare`): Piper is the only voice, after v0.3.1. */
  clips: boolean;
}

/** One shell section: prints one word per feature present. Cheap (one grep), so it runs every poll. */
export const FEATURES_CMD =
  'for f in penguin-weather penguin-sleep; do [ -x /usr/local/sbin/$f ] && echo $f; done; ' +
  'grep -q espeak /usr/local/sbin/penguin-sound 2>/dev/null && echo say; ' +
  'command -v espeak-ng >/dev/null 2>&1 && echo espeak; [ -x /usr/local/bin/piper ] && echo piper; ' +
  'grep -q -e --ready /usr/local/sbin/penguin-sound 2>/dev/null && echo clips; true';

export function parseFeatures(section: string | undefined): Features {
  const s = new Set((section ?? '').split('\n').map((x) => x.trim()));
  return {
    weather: s.has('penguin-weather'),
    sleep: s.has('penguin-sleep'),
    say: s.has('say'),
    espeak: s.has('espeak'),
    piper: s.has('piper'),
    clips: s.has('clips'),
  };
}

// --- Piper's voices: <name>.onnx (+ .onnx.json) in the image's folder and the user's.

export const PIPER_VOICE_DIRS = ['/usr/share/piper/voices', '/data/penguin/voices'];
/** Lists both folders (missing ones are fine); parsePiperVoices keeps the *.onnx names. Cheap, so it runs every poll. */
export const PIPER_VOICES_CMD = `ls ${PIPER_VOICE_DIRS.join(' ')} 2>/dev/null; true`;

/** A voice name PIPER_VOICE can hold (the file name without .onnx). */
export const validPiperVoice = (v: string) => /^[A-Za-z0-9_.-]{1,64}$/.test(v);

export function parsePiperVoices(text: string | undefined): string[] {
  const names = (text ?? '').split('\n').map((x) => x.trim())
    .filter((x) => x.endsWith('.onnx')).map((x) => x.slice(0, -'.onnx'.length)).filter(validPiperVoice);
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}

/** "v0.2.9" from /etc/techo5-release's first line, or null. */
export function releaseVersion(release: string | null | undefined): string | null {
  return release?.match(/v\d+(\.\d+)+/)?.[0] ?? null;
}
