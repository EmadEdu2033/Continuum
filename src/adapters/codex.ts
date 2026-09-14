import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentAdapter,
  ProviderHealth,
  SessionState,
} from "./types.js";
import type { AgentEvent, AgentInput } from "../types.js";
import { ContinuumError } from "../types.js";
import { classifyError } from "../errors.js";
import {
  findOnPath,
  spawnCli,
  type CliRunHandle,
  type SpawnOptions,
} from "./spawn-cli.js";

export interface CodexAdapterOptions {
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  spawnOverride?: Pick<SpawnOptions, "overrideBin" | "overrideArgs">;
}

export class CodexAdapter implements AgentAdapter {
  id = "codex";
  private sessionId: string | null = null;
  private lastActiveAt: string | null = null;
  private currentRun: CliRunHandle | null = null;

  constructor(private readonly opts: CodexAdapterOptions = {}) {}

  private bin(): string {
    const local = process.env.LOCALAPPDATA;
    const direct = local
      ? path.join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe")
      : "";
    try {
      fs.accessSync(direct);
      return direct;
    } catch {
      /* fall through to PATH */
    }
    return findOnPath("codex") ?? "codex";
  }

  async detect(): Promise<boolean> {
    try {
      fs.accessSync(this.bin());
      return true;
    } catch {
      return findOnPath("codex") !== null;
    }
  }

  async health(): Promise<ProviderHealth> {
    const installed = await this.detect();
    return { installed, authenticated: installed, state: installed ? "READY" : "UNAVAILABLE" };
  }

  /**
   * Verified probe: `codex login status` exits 0 with "Logged in ..."
   * when authenticated. Never throws — returns null when unverifiable.
   */
  async checkAuth(): Promise<{ ok: boolean; detail: string } | null> {
    try {
      const { execFile } = await import("node:child_process");
      const out = await new Promise<string>((resolve, reject) => {
        execFile(this.bin(), ["login", "status"], { timeout: 20000 }, (err, stdout, stderr) => {
          const text = `${stdout ?? ""}${stderr ?? ""}`;
          if (err) reject(new Error(text.trim() || err.message));
          else resolve(text);
        });
      });
      const ok = /logged in/i.test(out) && !/not logged in/i.test(out);
      return { ok, detail: ok ? out.trim().slice(0, 120) : "login status did not confirm authentication" };
    } catch (err: any) {
      const text = String(err?.message ?? err);
      if (/not logged in|not authenticated|login required/i.test(text)) {
        return { ok: false, detail: text.slice(0, 200) };
      }
      return null;
    }
  }

  async *start(input: AgentInput): AsyncIterable<AgentEvent> {
    yield* this.runChat(buildPrompt(input), undefined, input);
  }

  async *resume(sessionId: string, input: AgentInput): AsyncIterable<AgentEvent> {
    yield* this.runChat(buildPrompt(input), sessionId, input);
  }

  async interrupt(): Promise<void> {
    this.currentRun?.kill();
  }

  normalizeError(error: unknown): { code: import("../types.js").NormalizedError; message: string } {
    if (error instanceof ContinuumError) {
      return { code: error.code, message: error.detail };
    }
    return { code: classifyError(String(error)), message: String(error) };
  }

  async getSessionState(): Promise<SessionState> {
    return { sessionId: this.sessionId, lastActiveAt: this.lastActiveAt };
  }

  private async *runChat(prompt: string, sessionId: string | undefined, input: AgentInput): AsyncIterable<AgentEvent> {
    const at = () => new Date().toISOString();
    const base = ["exec", "--json", "-s", this.opts.sandbox ?? "workspace-write", "--skip-git-repo-check", "-C", input.cwd];
    if (this.opts.model) base.push("-m", this.opts.model);
    const args = sessionId ? [...base, "resume", sessionId, "-"] : [...base, "-"];

    const run = spawnCli(this.bin(), args, { cwd: input.cwd, stdin: prompt, ...this.opts.spawnOverride });
    this.currentRun = run;
    let finished = false;
    let sawError: { code: import("../types.js").NormalizedError; message: string } | null = null;

    try {
      for await (const line of run.lines()) {
        let evt: any;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        this.lastActiveAt = at();

        switch (evt.type) {
          case "thread.started":
            this.sessionId = evt.thread_id;
            yield { type: "SessionStarted", sessionId: evt.thread_id, providerId: this.id, at: at() };
            break;
          case "item.started":
            if (evt.item?.type === "command_execution") {
              yield { type: "ToolStarted", tool: "shell", input: { command: evt.item.command }, at: at() };
            }
            break;
          case "item.completed": {
            const item = evt.item ?? {};
            switch (item.type) {
              case "agent_message":
                if (item.text) yield { type: "TextDelta", text: item.text, at: at() };
                break;
              case "command_execution":
                yield { type: "CommandExecuted", command: item.command ?? "", exitCode: item.exit_code ?? null, at: at() };
                yield { type: "ToolFinished", tool: "shell", output: { exitCode: item.exit_code }, at: at() };
                break;
              case "file_change":
                for (const ch of item.changes ?? []) {
                  yield {
                    type: "FileChanged",
                    path: ch.path,
                    action: ch.kind === "add" ? "created" : ch.kind === "delete" ? "deleted" : "modified",
                    at: at(),
                  };
                }
                break;
              case "error":
                sawError = { code: classifyError(item.message ?? ""), message: item.message ?? "codex item error" };
                yield { type: "AgentError", error: sawError.code, message: sawError.message, at: at() };
                break;
            }
            break;
          }
          case "turn.completed":
            if (evt.usage) {
              yield {
                type: "UsageUpdated",
                tokensIn: evt.usage.input_tokens ?? 0,
                tokensOut: (evt.usage.output_tokens ?? 0) + (evt.usage.reasoning_output_tokens ?? 0),
                at: at(),
              };
            }
            break;
          case "turn.failed": {
            const msg = evt.error?.message ?? JSON.stringify(evt.error ?? "turn failed");
            sawError = { code: classifyError(msg), message: msg };
            yield { type: "AgentError", error: sawError.code, message: msg, at: at() };
            break;
          }
          case "error": {
            const msg = evt.message ?? JSON.stringify(evt);
            sawError = { code: classifyError(msg), message: msg };
            yield { type: "AgentError", error: sawError.code, message: msg, at: at() };
            break;
          }
        }
      }

      const { code } = await run.wait();
      if (sawError) throw new ContinuumError(sawError.code, sawError.message);
      if (code !== 0) {
        const raw = run.stderrText() || `codex exited with code ${code}`;
        const norm = classifyError(raw);
        yield { type: "AgentError", error: norm, message: raw.slice(0, 500), at: at() };
        throw new ContinuumError(norm, raw);
      }
      finished = true;
      yield { type: "SessionFinished", reason: "completed", at: at() };
    } finally {
      this.currentRun = null;
      if (!finished) {
        yield { type: "SessionFinished", reason: "interrupted", at: at() };
      }
    }
  }
}

function buildPrompt(input: AgentInput): string {
  if (!input.handoff) return input.task;
  return [
    input.task,
    "",
    "=== CONTINUUM HANDOFF ===",
    "A previous coding agent worked on this same task in this repository and stopped.",
    "Inspect the current repository state first. Do not assume the handoff summary is",
    "perfectly current. Continue the existing task rather than restarting it.",
    "",
    input.handoff,
  ].join("\n");
}
