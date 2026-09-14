/**
 * Minimal terminal control for the dashboard. Zero dependencies: raw ANSI
 * escape sequences work on Windows Terminal, PowerShell 7, Linux and macOS.
 * Everything degrades to plain output when stdout is not a TTY.
 */
export interface Size {
  rows: number;
  cols: number;
}

const ESC = "\x1b[";

export const isTty = (): boolean => Boolean(process.stdout.isTTY);

export function size(): Size {
  return {
    rows: process.stdout.rows ?? 30,
    cols: process.stdout.columns ?? 100,
  };
}

export function enterAltScreen(): void {
  write(`${ESC}?1049h`);
}

export function exitAltScreen(): void {
  write(`${ESC}?1049l`);
}

export function hideCursor(): void {
  write(`${ESC}?25l`);
}

export function showCursor(): void {
  write(`${ESC}?25h`);
}

export function resetStyle(): void {
  write(`${ESC}0m`);
}

export function clearScreen(): void {
  write(`${ESC}2J${ESC}H`);
}

/** Move to a 1-based row/column and draw the frame in one write (no flicker). */
export function draw(frame: string): void {
  write(`${ESC}H${frame}`);
}

export function write(s: string): void {
  process.stdout.write(s);
}

export interface Key {
  name: string;
  ctrl: boolean;
  raw: string;
}

/** Puts the terminal in raw mode and reports keypresses. Returns a restore fn. */
export function startInput(onKey: (key: Key) => void): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {};
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const handler = (chunk: string) => {
    for (const raw of splitKeys(chunk)) {
      onKey(decode(raw));
    }
  };
  stdin.on("data", handler);

  return () => {
    stdin.off("data", handler);
    try {
      stdin.setRawMode(false);
    } catch {
      /* already restored */
    }
    stdin.pause();
  };
}

/** Escape sequences can arrive coalesced; split them into logical keys. */
function splitKeys(chunk: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === "\x1b" && chunk[i + 1] === "[") {
      keys.push(chunk.slice(i, i + 3));
      i += 3;
    } else {
      keys.push(chunk[i]);
      i += 1;
    }
  }
  return keys;
}

function decode(raw: string): Key {
  const map: Record<string, string> = {
    "\r": "enter",
    "\n": "enter",
    "\x7f": "backspace",
    "\x1b[A": "up",
    "\x1b[B": "down",
    "\x1b[C": "right",
    "\x1b[D": "left",
    "\x03": "c",
    "\x1b": "escape",
  };
  return { name: map[raw] ?? raw, ctrl: raw === "\x03", raw };
}

export function onResize(handler: () => void): () => void {
  process.stdout.on("resize", handler);
  return () => process.stdout.off("resize", handler);
}
