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

export interface OpenCodeAdapterOptions {
  /** Optional `provider/model`; uses the CLI's configured default otherwise. */
  model?: string;
  /** Auto-approve permissions so the agent can edit files unattended. */
  autoApprove?: boolean;
  /** Test hook: replaces the real binary. */
  spawnOverride?: Pick<SpawnOptions, "overrideBin" | "overrideArgs">;
}

export class OpenCodeAdapter implements AgentAdapter {
  id = "opencode";
  private sessionId: string | null = null;
  private lastActiveAt: string | null = null;
  private currentRun: CliRunHandle | null = null;

  constructor(private readonly opts: OpenCodeAdapterOptions = {}) {}

  private bin(): string {
    const appData = process.env.APPDATA;
    const direct = appData
      ? path.join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe")
      : "";
    try {
      fs.accessSync(direct);
      return direct;
    } catch {
      /* fall through to PATH */
    }
    return findOnPath("opencode") ?? "opencode";
  }

  async detect(): Promise<boolean> {
    try {
      fs.accessSync(this.bin());
      return true;
    } catch {
      return findOnPath("opencode") !== null;
    }
  }

  async health(): Promise<ProviderHealth> {
    const installed = await this.detect();
    return {
      installed,
      authenticated: installed, // auth state only surfaces on real runs
      state: installed ? "READY" : "UNAVAILABLE",
    };
  }

  async *start(input: AgentInput): AsyncIterable<AgentEvent> {
    yield* this.runChat(buildMessage(input), undefined, input);
  }

  async *resume(sessionId: string, input: AgentInput): AsyncIterable<AgentEvent> {
    yield* this.runChat(buildMessage(input), sessionId, input);
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

  private argsFor(message: string, sessionId?: string): string[] {
    const args = ["run", message, "--format", "json"];
    if (sessionId) args.push("-s", sessionId);
    if (this.opts.model) args.push("-m", this.opts.model);
    if (this.opts.autoApprove !== false) args.push("--auto");
    return args;
  }

  private async *runChat(message: string, sessionId: string | undefined, input: AgentInput): AsyncIterable<AgentEvent> {
    const at = () => new Date().toISOString();
    const run = spawnCli(this.bin(), this.argsFor(message, sessionId), {
      cwd: input.cwd,
      ...this.opts.spawnOverride,
    });
    this.currentRun = run;
    let finished = false;
    let sawError: { code: import("../types.js").NormalizedError; message: string } | null = null;

    try {
      for await (const line of run.lines()) {
        let evt: any;
        try {
          evt = JSON.parse(line);
        } catch {
          continue; // non-JSON noise on stdout
        }

        if (evt.sessionID && !this.sessionId) {
          this.sessionId = evt.sessionID;
          yield { type: "SessionStarted", sessionId: evt.sessionID, providerId: this.id, at: at() };
        }
        this.lastActiveAt = at();

        switch (evt.type) {
          case "text":
            if (evt.part?.text) yield { type: "TextDelta", text: evt.part.text, at: at() };
            break;
          case "tool": {
            const status = evt.part?.state?.status;
            if (status === "completed" || status === "error") {
              yield { type: "ToolFinished", tool: evt.part?.tool ?? "tool", output: evt.part?.state?.output, at: at() };
            } else {
              yield { type: "ToolStarted", tool: evt.part?.tool ?? "tool", input: evt.part?.state?.input, at: at() };
            }
            break;
          }
          case "step_finish":
            if (evt.part?.tokens) {
              yield {
                type: "UsageUpdated",
                tokensIn: evt.part.tokens.input ?? 0,
                tokensOut: (evt.part.tokens.output ?? 0) + (evt.part.tokens.reasoning ?? 0),
                at: at(),
              };
            }
            break;
          case "error": {
            const msg =
              evt.error?.data?.message ?? evt.error?.message ?? JSON.stringify(evt.error ?? evt);
            sawError = { code: classifyError(`${evt.error?.name ?? ""} ${msg}`), message: msg };
            yield { type: "AgentError", error: sawError.code, message: msg, at: at() };
            break;
          }
        }
      }

      const { code } = await run.wait();
      if (sawError) throw new ContinuumError(sawError.code, sawError.message);
      if (code !== 0) {
        const raw = run.stderrText() || `opencode exited with code ${code}`;
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

function buildMessage(input: AgentInput): string {
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
