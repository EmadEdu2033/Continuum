/** Color theme matching the logo: cyan → violet, on a dark terminal. */
const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;

export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: rgb(34, 211, 238),
  violet: rgb(167, 139, 250),
  green: rgb(74, 222, 128),
  yellow: rgb(250, 204, 21),
  red: rgb(248, 113, 113),
  gray: rgb(148, 163, 184),
  white: rgb(226, 232, 240),
  blue: rgb(96, 165, 250),
};

/** Width of a string ignoring ANSI escape sequences. */
export function width(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function truncate(s: string, max: number): string {
  if (width(s) <= max) return s;
  if (max <= 1) return s.slice(0, max);
  let out = "";
  let visible = 0;
  for (const ch of stripAnsiStream(s)) {
    if (visible >= max - 1) break;
    out += ch;
    visible++;
  }
  return out + "…";
}

export function pad(s: string, len: number): string {
  const w = width(s);
  return w >= len ? truncate(s, len) : s + " ".repeat(len - w);
}

/** Iterate over characters while preserving ANSI sequences as whole units. */
function* stripAnsiStream(s: string): Generator<string> {
  const re = /\x1b\[[0-9;]*m/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    for (const ch of s.slice(last, m.index)) yield ch;
    yield m[0];
    last = m.index + m[0].length;
  }
  for (const ch of s.slice(last)) yield ch;
}

export const BADGE: Record<string, string> = {
  READY: `${c.green}●${c.reset}`,
  ACTIVE: `${c.cyan}◉${c.reset}`,
  COOLDOWN: `${c.yellow}◔${c.reset}`,
  EXHAUSTED: `${c.red}◌${c.reset}`,
  AUTH_REQUIRED: `${c.yellow}⚿${c.reset}`,
  UNAVAILABLE: `${c.gray}○${c.reset}`,
  FAILED: `${c.red}✖${c.reset}`,
};

export function stateColor(state: string): string {
  switch (state) {
    case "READY":
      return c.green;
    case "ACTIVE":
      return c.cyan;
    case "COOLDOWN":
    case "AUTH_REQUIRED":
      return c.yellow;
    case "EXHAUSTED":
    case "FAILED":
      return c.red;
    default:
      return c.gray;
  }
}

/** A labeled progress bar: `[██████████░░░░░░] 62%`. */
export function bar(ratio: number, len: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * len);
  return `${c.cyan}${"█".repeat(filled)}${c.gray}${"░".repeat(len - filled)}${c.reset}`;
}

export function boxTop(title: string, len: number): string {
  const t = ` ${title} `;
  const dashes = Math.max(0, len - width(t) - 2);
  return `${c.gray}┌─${c.reset}${c.bold}${t}${c.reset}${c.gray}${"─".repeat(dashes)}┐${c.reset}`;
}

export function boxBottom(len: number): string {
  return `${c.gray}└${"─".repeat(Math.max(0, len - 2))}┘${c.reset}`;
}

export function boxRow(content: string, len: number): string {
  const inner = len - 4;
  return `${c.gray}│${c.reset} ${pad(content, inner)} ${c.gray}│${c.reset}`;
}
