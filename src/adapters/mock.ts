import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  AgentAdapter,
  ProviderHealth,
  SessionState,
} from "./types.js";
import type { AgentEvent, AgentInput } from "../types.js";
import { ContinuumError } from "../types.js";

/**
 * A scriptable mock provider used to test the core runtime before any real
 * CLI integration exists. Each step either writes a file, runs a shell
 * command, emits text, or fails with a normalized error.
 */
export type MockStep =
  | { kind: "writeFile"; path: string; content: string }
  | { kind: "run"; command: string }
  | { kind: "say"; text: string }
  | { kind: "usage"; tokensIn: number; tokensOut: number }
  | { kind: "fail"; error: import("../types.js").NormalizedError; message: string };

export interface MockProviderConfig {
  id: string;
  script: MockStep[];
}

export class MockProvider implements AgentAdapter {
  private sessionId: string | null = null;
  private lastActiveAt: string | null = null;
  private interrupted = false;
  /** Continues from the step after the last executed one on later attempts,
   *  mirroring "resume the task, don't restart it". */
  private stepIndex = 0;

  constructor(private readonly config: MockProviderConfig) {}

  get id(): string {
    return this.config.id;
  }

  async detect(): Promise<boolean> {
    return true;
  }

  async health(): Promise<ProviderHealth> {
    return {
      installed: true,
      authenticated: true,
      version: "mock-1.0",
      state: "READY",
    };
  }

  async *start(input: AgentInput): AsyncIterable<AgentEvent> {
    yield* this.runScript(input);
  }

  async *resume(sessionId: string, input: AgentInput): AsyncIterable<AgentEvent> {
    this.sessionId = sessionId;
    yield* this.runScript(input);
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  normalizeError(error: unknown): { code: import("../types.js").NormalizedError; message: string } {
    if (error instanceof ContinuumError) {
      return { code: error.code, message: error.message };
    }
    return { code: "AGENT_CRASH", message: String(error) };
  }

  async getSessionState(): Promise<SessionState> {
    return { sessionId: this.sessionId, lastActiveAt: this.lastActiveAt };
  }

  private async *runScript(input: AgentInput): AsyncIterable<AgentEvent> {
    const at = () => new Date().toISOString();
    this.sessionId = `${this.config.id}-${Date.now().toString(36)}`;
    this.interrupted = false;

    yield { type: "SessionStarted", sessionId: this.sessionId, providerId: this.config.id, at: at() };

    if (input.handoff) {
      yield { type: "TextDelta", text: `[${this.config.id}] Received handoff:\n${input.handoff}\n`, at: at() };
      yield {
        type: "TextDelta",
        text: `[${this.config.id}] Inspecting repository state before continuing.\n`,
        at: at(),
      };
    }

    while (this.stepIndex < this.config.script.length) {
      const step = this.config.script[this.stepIndex];
      if (this.interrupted) {
        yield { type: "SessionFinished", reason: "interrupted", at: at() };
        return;
      }
      this.lastActiveAt = at();
      this.stepIndex++;

      switch (step.kind) {
        case "say":
          yield { type: "TextDelta", text: `[${this.config.id}] ${step.text}\n`, at: at() };
          break;
        case "writeFile": {
          yield { type: "ToolStarted", tool: "write_file", input: { path: step.path }, at: at() };
          const abs = path.resolve(input.cwd, step.path);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          const existed = await fs
            .stat(abs)
            .then(() => true)
            .catch(() => false);
          await fs.writeFile(abs, step.content, "utf8");
          yield {
            type: "FileChanged",
            path: step.path,
            action: existed ? "modified" : "created",
            at: at(),
          };
          yield { type: "ToolFinished", tool: "write_file", output: { path: step.path }, at: at() };
          break;
        }
        case "run": {
          yield { type: "ToolStarted", tool: "shell", input: { command: step.command }, at: at() };
          const exitCode = await runShell(step.command, input.cwd);
          yield { type: "CommandExecuted", command: step.command, exitCode, at: at() };
          yield { type: "ToolFinished", tool: "shell", output: { exitCode }, at: at() };
          break;
        }
        case "usage":
          yield { type: "UsageUpdated", tokensIn: step.tokensIn, tokensOut: step.tokensOut, at: at() };
          break;
        case "fail":
          yield { type: "AgentError", error: step.error, message: step.message, at: at() };
          throw new ContinuumError(step.error, step.message);
      }
    }

    yield { type: "SessionFinished", reason: "completed", at: at() };
  }
}

function runShell(command: string, cwd: string): Promise<number | null> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "cmd" : "sh", isWin ? ["/c", command] : ["-c", command], { cwd });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
}
