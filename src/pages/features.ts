// What the Echo's echo-penguin can do among the features added in v0.3.0 (gradual wake, night clock,
// weather, speech, sleep diary), detected from the files on the unit like alarms.ts detects the alarm
// format, so the pages keep working with older images. This covers the programs those features need;
// settings-only ones (gradual wake, night clock) are detected from their keys in defaults.conf.

export const NEEDS_V030 = 'requer echo-penguin v0.3.0';

export interface Features {
  /** /usr/local/sbin/penguin-weather */
  weather: boolean;
  /** /usr/local/sbin/penguin-sleep */
  sleep: boolean;
  /** penguin-sound has the `say` subcommand. */
  say: boolean;
  /** espeak-ng is installed (`say` needs it). */
  espeak: boolean;
}

/** One shell section: prints one word per feature present. Cheap (one grep), so it runs every poll. */
export const FEATURES_CMD =
  'for f in penguin-weather penguin-sleep; do [ -x /usr/local/sbin/$f ] && echo $f; done; ' +
  'grep -q espeak /usr/local/sbin/penguin-sound 2>/dev/null && echo say; ' +
  'command -v espeak-ng >/dev/null 2>&1 && echo espeak; true';

export function parseFeatures(section: string | undefined): Features {
  const s = new Set((section ?? '').split('\n').map((x) => x.trim()));
  return {
    weather: s.has('penguin-weather'),
    sleep: s.has('penguin-sleep'),
    say: s.has('say'),
    espeak: s.has('espeak'),
  };
}

/** "v0.2.9" from /etc/techo5-release's first line, or null. */
export function releaseVersion(release: string | null | undefined): string | null {
  return release?.match(/v\d+(\.\d+)+/)?.[0] ?? null;
}
