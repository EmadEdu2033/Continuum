import * as fs from "node:fs";
import type {
  AgentAdapter,
  ProviderHealth,
  SessionState,
} from "./types.js";
import type { AgentEvent, AgentInput } from "../types.js";
import { ContinuumError } from "../types.js";
import { classifyError } from "../errors.js";
import {
  resolveBinary,
  findOnPath,
  spawnCli,
  type CliRunHandle,
  type SpawnOptions,
} from "./spawn-cli.js";

export interface AntigravityAdapterOptions {
  model?: string;
  spawnOverride?: Pick<SpawnOptions, "overrideBin" | "overrideArgs">;
}

/**
 * Best-effort adapter for the Google Antigravity CLI headless mode
 * (`agy -p <prompt> --output-format stream-json`, `--conversation` to resume).
 * The event shapes may shift while the CLI is in beta; unknown lines are
 * ignored and failures are classified like any other provider.
 */
export class AntigravityAdapter implements AgentAdapter {
  id = "antigravity";
  private sessionId: string | null = null;
  private lastActiveAt: string | null = null;
  private currentRun: CliRunHandle | null = null;

  constructor(private readonly opts: AntigravityAdapterOptions = {}) {}

  private bin(): string {
    return resolveBinary(["/usr/local/bin/agy", "/usr/bin/agy", "agy"]) ?? "agy";
  }

  async detect(): Promise<boolean> {
    return findOnPath("agy") !== null;
  }

  async health(): Promise<ProviderHealth> {
    const installed = await this.detect();
    return { installed, authenticated: installed, state: installed ? "READY" : "UNAVAILABLE" };
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
      return { code: error.code, message: error.message };
    }
    return { code: classifyError(String(error)), message: String(error) };
  }

  async getSessionState(): Promise<SessionState> {
    return { sessionId: this.sessionId, lastActiveAt: this.lastActiveAt };
  }

  private async *runChat(prompt: string, sessionId: string | undefined, input: AgentInput): AsyncIterable<AgentEvent> {
    const at = () => new Date().toISOString();
    const args = ["-p", prompt, "--output-format", "stream-json"];
    if (sessionId) args.push("--conversation", sessionId);
    if (this.opts.model) args.push("--model", this.opts.model);

    const run = spawnCli(this.bin(), args, { cwd: input.cwd, ...this.opts.spawnOverride });
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

        if (evt.conversation_id ?? evt.sessionId ?? evt.session_id) {
          const sid = evt.conversation_id ?? evt.sessionId ?? evt.session_id;
          if (!this.sessionId) {
            this.sessionId = sid;
            yield { type: "SessionStarted", sessionId: sid, providerId: this.id, at: at() };
          }
        }
        switch (evt.type) {
          case "text":
          case "assistant":
            const text = evt.text ?? evt.delta ?? evt.message?.content;
            if (typeof text === "string" && text) yield { type: "TextDelta", text, at: at() };
            break;
          case "tool_use":
          case "tool_start":
            yield { type: "ToolStarted", tool: evt.name ?? evt.tool ?? "tool", input: evt.input, at: at() };
            break;
          case "tool_result":
          case "tool_end":
            yield { type: "ToolFinished", tool: evt.name ?? evt.tool ?? "tool", at: at() };
            break;
          case "usage":
            yield {
              type: "UsageUpdated",
              tokensIn: evt.input_tokens ?? evt.input ?? 0,
              tokensOut: evt.output_tokens ?? evt.output ?? 0,
              at: at(),
            };
            break;
          case "error":
            const msg = evt.message ?? evt.error?.message ?? JSON.stringify(evt);
            sawError = { code: classifyError(msg), message: String(msg).slice(0, 500) };
            yield { type: "AgentError", error: sawError.code, message: sawError.message, at: at() };
            break;
        }
      }

      const { code } = await run.wait();
      if (sawError) throw new ContinuumError(sawError.code, sawError.message);
      if (code !== 0) {
        const raw = run.stderrText() || `agy exited with code ${code}`;
        const norm = classifyError(raw);
        yield { type: "AgentError", error: norm, message: raw.slice(0, 500), at: at() };
        throw new ContinuumError(norm, raw);
      }
      if (!this.sessionId) {
        // No session id was surfaced; still record a session lifecycle.
        this.sessionId = `antigravity-${Date.now().toString(36)}`;
        yield { type: "SessionStarted", sessionId: this.sessionId, providerId: this.id, at: at() };
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
    "Inspect the current repository state first. Continue the existing task rather than",
    "restarting it.",
    "",
    input.handoff,
  ].join("\n");
}
