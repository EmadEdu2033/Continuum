import type { NormalizedError } from "./types.js";

export interface ProviderView {
  id: string;
  state: string;
  version?: string;
}

export type RunStatus = "idle" | "running" | "completed" | "exhausted" | "paused";

/** Point-in-time view of a supervised run — everything the TUI needs to draw. */
export interface SupervisorSnapshot {
  task: string;
  taskId: number;
  order: string[];
  index: number;
  providerId: string | null;
  status: RunStatus;
  filesTouched: number;
  commandsRun: number;
  startedAt: number;
  activeSince: number | null;
  lastError: { code: NormalizedError; message: string } | null;
  checkpointId: string | null;
  handoffCount: number;
  message: string;
}

/** Observer the supervisor reports to. Plain logging and the TUI both use it. */
export interface Telemetry {
  onLog?(line: string): void;
  onSnapshot?(snapshot: SupervisorSnapshot): void;
}
