/** ANSI colors without dependency; disabled when not a TTY or when NO_COLOR is set. */
export const colorEnabled = (): boolean => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const fg = (code: number) => (s: string) => (colorEnabled() ? `\x1b[38;5;${code}m${s}\x1b[39m` : s);
export const bold = (s: string) => (colorEnabled() ? `\x1b[1m${s}\x1b[22m` : s);
export const dim = (s: string) => (colorEnabled() ? `\x1b[2m${s}\x1b[22m` : s);
export const green = fg(71);
export const red = fg(167);
export const yellow = fg(179);

/**
 * One color per model, by provider family: Claude in warm tones (terra, amber, sand),
 * Codex in cool tones (green, teal, blue). Unknown models get a stable color from their name.
 */
const MODEL_COLORS: Array<[RegExp, number]> = [
  [/opus/, 173],
  [/sonnet/, 215],
  [/haiku/, 223],
  [/fable|mythos/, 168],
  [/astra/, 78],
  [/sol/, 44],
  [/luna/, 111],
  [/terra/, 114],
  [/gpt-5\.5/, 146],
];
const FALLBACK = [180, 109, 139, 150, 181, 117];

export function modelColor(model: string): (s: string) => string {
  const hit = MODEL_COLORS.find(([re]) => re.test(model));
  if (hit) return fg(hit[1]);
  let h = 0;
  for (const c of model) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return fg(FALLBACK[h % FALLBACK.length]!);
}

/** Visible length of a string that may contain ANSI codes. */
export const visibleLength = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
