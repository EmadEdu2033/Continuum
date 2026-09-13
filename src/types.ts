// Continuum normalized protocol: events, errors, provider states.

export type ProviderState =
  | "READY"
  | "ACTIVE"
  | "COOLDOWN"
  | "EXHAUSTED"
  | "AUTH_REQUIRED"
  | "UNAVAILABLE"
  | "FAILED";

export type NormalizedError =
  | "QUOTA_EXHAUSTED"
  | "TEMP_RATE_LIMIT"
  | "AUTH_REQUIRED"
  | "PROVIDER_UNAVAILABLE"
  | "CONTEXT_EXHAUSTED"
  | "PERMISSION_REQUIRED"
  | "NETWORK_FAILURE"
  | "AGENT_CRASH"
  | "USER_CANCELLED";

export interface SessionStarted {
  type: "SessionStarted";
  sessionId: string;
  providerId: string;
  at: string;
}
export interface TextDelta {
  type: "TextDelta";
  text: string;
  at: string;
}
export interface ToolStarted {
  type: "ToolStarted";
  tool: string;
  input?: unknown;
  at: string;
}
export interface ToolFinished {
  type: "ToolFinished";
  tool: string;
  output?: unknown;
  at: string;
}
export interface CommandExecuted {
  type: "CommandExecuted";
  command: string;
  exitCode: number | null;
  at: string;
}
export interface FileChanged {
  type: "FileChanged";
  path: string;
  action: "created" | "modified" | "deleted";
  at: string;
}
export interface UsageUpdated {
  type: "UsageUpdated";
  tokensIn: number;
  tokensOut: number;
  at: string;
}
export interface CheckpointCreated {
  type: "CheckpointCreated";
  checkpointId: string;
  at: string;
}
export interface AgentErrorEvent {
  type: "AgentError";
  error: NormalizedError;
  message: string;
  at: string;
}
export interface SessionFinished {
  type: "SessionFinished";
  reason: "completed" | "failed" | "interrupted";
  at: string;
}

export type AgentEvent =
  | SessionStarted
  | TextDelta
  | ToolStarted
  | ToolFinished
  | CommandExecuted
  | FileChanged
  | UsageUpdated
  | CheckpointCreated
  | AgentErrorEvent
  | SessionFinished;

export interface AgentInput {
  /** The full task instruction. */
  task: string;
  /** Handoff capsule text, if this run continues from another provider. */
  handoff?: string;
  /** Working directory of the managed repository. */
  cwd: string;
}

export class ContinuumError extends Error {
  constructor(
    public readonly code: NormalizedError,
    message: string
  ) {
    super(`[${code}] ${message}`);
  }
}
