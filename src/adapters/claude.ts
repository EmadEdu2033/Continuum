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
  resolveBinary,
  findOnPath,
  spawnCli,
  type CliRunHandle,
  type SpawnOptions,
} from "./spawn-cli.js";

export interface ClaudeAdapterOptions {
  model?: string;
  /** Skip permission prompts so the agent can edit files unattended. */
  skipPermissions?: boolean;
  spawnOverride?: Pick<SpawnOptions, "overrideBin" | "overrideArgs">;
}

/**
 * Adapter for the Claude Code CLI (`claude -p --output-format stream-json`).
 */
export class ClaudeAdapter implements AgentAdapter {
  id = "claude";
  private sessionId: string | null = null;
  private lastActiveAt: string | null = null;
  private currentRun: CliRunHandle | null = null;

  constructor(private readonly opts: ClaudeAdapterOptions = {}) {}

  /** cli.js is run through node; .exe/bare names spawn directly. */
  private cmd(): { bin: string; prefix: string[] } {
    const appData = process.env.APPDATA;
    const cliJs =
      appData
        ? path.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js")
        : "";
    const resolved = resolveBinary([cliJs, "/usr/local/bin/claude", "/usr/bin/claude", "claude"]);
    if (resolved && resolved.endsWith(".js") && fs.existsSync(resolved)) {
      return { bin: process.execPath, prefix: [resolved] };
    }
    return { bin: resolved ?? "claude", prefix: [] };
  }

  async detect(): Promise<boolean> {
    const { prefix } = this.cmd();
    if (prefix.length) {
      try {
        fs.accessSync(prefix[0]);
        return true;
      } catch {
        return false;
      }
    }
    return findOnPath("claude") !== null;
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
    const { bin, prefix } = this.cmd();
    const args = [
      ...prefix,
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    if (sessionId) args.push("--resume", sessionId);
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.opts.skipPermissions !== false) args.push("--dangerously-skip-permissions");

    const run = spawnCli(bin, args, { cwd: input.cwd, ...this.opts.spawnOverride });
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
          case "system":
            if (evt.subtype === "init" && evt.session_id) {
              this.sessionId = evt.session_id;
              yield { type: "SessionStarted", sessionId: evt.session_id, providerId: this.id, at: at() };
            }
            break;
          case "assistant": {
            for (const block of evt.message?.content ?? []) {
              if (block.type === "text" && block.text) {
                yield { type: "TextDelta", text: block.text, at: at() };
              } else if (block.type === "tool_use") {
                yield { type: "ToolStarted", tool: block.name ?? "tool", input: block.input, at: at() };
              }
            }
            break;
          }
          case "user": {
            for (const block of evt.message?.content ?? []) {
              if (block.type === "tool_result") {
                yield { type: "ToolFinished", tool: "tool", output: undefined, at: at() };
              }
            }
            break;
          }
          case "result": {
            if (evt.usage) {
              yield {
                type: "UsageUpdated",
                tokensIn: evt.usage.input_tokens ?? 0,
                tokensOut: evt.usage.output_tokens ?? 0,
                at: at(),
              };
            }
            if (evt.is_error || (evt.subtype && evt.subtype !== "success")) {
              const msg = evt.result ?? evt.subtype ?? "claude run failed";
              sawError = { code: classifyError(`${evt.subtype ?? ""} ${msg}`), message: String(msg).slice(0, 500) };
              yield { type: "AgentError", error: sawError.code, message: sawError.message, at: at() };
            }
            break;
          }
        }
      }

      const { code } = await run.wait();
      if (sawError) throw new ContinuumError(sawError.code, sawError.message);
      if (code !== 0) {
        const raw = run.stderrText() || `claude exited with code ${code}`;
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
