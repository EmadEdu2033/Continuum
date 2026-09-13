import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";

export interface CliRunHandle {
  lines(): AsyncIterable<string>;
  wait(): Promise<{ code: number | null }>;
  stderrText(): string;
  kill(): void;
}

export interface SpawnOptions {
  cwd: string;
  stdin?: string;
  /** Test hook: run this instead of the resolved provider binary. */
  overrideBin?: string;
  overrideArgs?: string[];
}

/**
 * Resolves a provider executable. Windows npm shims (.cmd) are not spawnable
 * without a shell, so adapters list the real .exe paths first.
 */
export function resolveBinary(candidates: string[]): string | null {
  for (const c of candidates) {
    if (path.isAbsolute(c) && fs.existsSync(c)) return c;
  }
  // Bare name: let CreateProcess/unix PATH resolution try (adds .exe on win).
  return candidates[candidates.length - 1] ?? null;
}

/** Honest PATH lookup for bare binary names (checks .exe/.cmd on Windows). */
export function findOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".exe;.cmd;.bat").split(";")
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/**
 * Spawns a CLI and exposes its stdout as a live stream of lines — events are
 * consumed as the agent produces them, not after it exits. .cmd/.bat targets
 * (Windows npm shims) are routed through cmd.exe because Node refuses to
 * spawn them directly without a shell.
 */
export function spawnCli(bin: string, args: string[], opts: SpawnOptions): CliRunHandle {
  const lower = bin.toLowerCase();
  const needsShell = lower.endsWith(".cmd") || lower.endsWith(".bat");
  const argv = needsShell ? ["cmd.exe", ["/c", bin, ...args]] : [bin, args];
  const child = spawn(argv[0] as string, argv[1] as string[], {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d.toString()));

  if (opts.stdin !== undefined) {
    child.stdin?.write(opts.stdin);
  }
  child.stdin?.end();

  const exitCode = new Promise<{ code: number | null }>((resolve) => {
    child.on("error", () => resolve({ code: -1 }));
    child.on("close", (code) => resolve({ code }));
  });

  async function* lines(): AsyncIterable<string> {
    if (!child.stdout) return;
    const rl = createInterface({ input: child.stdout });
    for await (const line of rl) {
      if (line.trim()) yield line;
    }
  }

  return {
    lines,
    wait: () => exitCode,
    stderrText: () => stderr,
    kill: () => child.kill(),
  };
}
