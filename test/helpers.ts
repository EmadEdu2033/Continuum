import type { AgentEvent } from "../src/types.js";

const at = (n: number) => new Date(Date.now() + n).toISOString();

/** Two-session event history: codex writes + fails, claude continues. Mirrors
 *  a real quota handoff, including an echoed capsule we must NOT re-summarize. */
export function plainEvents(): AgentEvent[] {
  return [
    { type: "SessionStarted", sessionId: "s1", providerId: "codex", at: at(0) },
    { type: "TextDelta", text: "Starting auth implementation.", at: at(1) },
    { type: "FileChanged", path: "src/auth.ts", action: "created", at: at(2) },
    { type: "CommandExecuted", command: "npm test", exitCode: 0, at: at(3) },
    { type: "AgentError", error: "QUOTA_EXHAUSTED", message: "import failed: usage limit", at: at(4) },
    { type: "SessionFinished", reason: "failed", at: at(5) },
    { type: "SessionStarted", sessionId: "s2", providerId: "claude", at: at(6) },
    { type: "TextDelta", text: "Received handoff: PROJECT demo\nGOAL auth", at: at(7) },
    { type: "FileChanged", path: "src/auth.ts", action: "modified", at: at(8) },
    { type: "SessionFinished", reason: "completed", at: at(9) },
  ];
}
