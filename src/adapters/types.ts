import type { AgentEvent, AgentInput, NormalizedError } from "../types.js";
import type { ProviderState } from "../types.js";

export interface ProviderHealth {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  state: ProviderState;
}

export interface SessionState {
  sessionId: string | null;
  lastActiveAt: string | null;
}

export interface AgentAdapter {
  id: string;
  /** Best-effort detection that the provider CLI exists. */
  detect(): Promise<boolean>;
  health(): Promise<ProviderHealth>;
  start(input: AgentInput): AsyncIterable<AgentEvent>;
  resume(sessionId: string, input: AgentInput): AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  normalizeError(error: unknown): { code: NormalizedError; message: string };
  getSessionState(): Promise<SessionState>;
}
