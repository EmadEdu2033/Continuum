import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "./store.js";
import type { CheckpointResult } from "./checkpoint.js";
import type { AgentEvent, NormalizedError } from "./types.js";

/**
 * Builds a handoff capsule from Continuum's own recorded state — never from a
 * provider transcript. Works even if the previous agent died mid-task.
 * Only events belonging to this task are included.
 */
export function buildHandoffCapsule(params: {
  store: Store;
  cwd: string;
  projectId: string;
  task: string;
  taskId: number;
  fromProvider: string;
  reason: NormalizedError;
  checkpoint: CheckpointResult;
  maxTokens: number;
  summary?: string;
}): string {
  const { store, projectId, task, taskId, fromProvider, reason, checkpoint, maxTokens, summary } = params;

  const events = store.readEvents().filter((e) => e.taskId === taskId);
  const filesTouched = new Map<string, "created" | "modified" | "deleted">(); // provider-agnostic file map
  const commands: string[] = [];
  const lastTexts: string[] = [];

  for (const e of events) {
    applyEvent(e, filesTouched, commands, lastTexts);
  }

  const decisions = readMemoryFile(store.root, "decisions.md");
  const constraints = readMemoryFile(store.root, "constraints.md");

  const sections = [
    `PROJECT\n${projectId}`,
    `TASK\n${task}`,
    `HANDOFF\n#${store.nextHandoffId()} from ${fromProvider} (${reason}) at ${new Date().toISOString()}`,
    `CURRENT STATE\nCheckpoint #${checkpoint.id} captured. ${filesTouched.size} file(s) touched this session.`,
    summary ? `SESSION SUMMARY (compacted)\n${summary}` : "",
    `FILES TOUCHED\n${[...filesTouched.entries()].map(([p, a]) => `${p} (${a})`).join("\n") || "(none)"}`,
    `GIT STATUS\n${checkpoint.gitStatus?.trim() || "(clean or no git)"}`,
    `DECISIONS\n${decisions || "(none recorded)"}`,
    `CONSTRAINTS\n${constraints || "(none recorded)"}`,
    `COMMANDS EXECUTED (recent)\n${commands.slice(-10).join("\n") || "(none)"}`,
    `LAST AGENT NOTES\n${lastTexts.slice(-5).join("\n") || "(none)"}`,
    `NEXT ACTION\nInspect the current repository state first. Do not assume this summary is perfectly current. Continue the existing task rather than restarting it.`,
  ];

  let capsule = sections.filter((s) => s && s.trim().length > 0).join("\n\n");
  // Rough token budget guard (~4 chars/token).
  const maxChars = maxTokens * 4;
  if (capsule.length > maxChars) {
    capsule = capsule.slice(0, maxChars) + "\n\n(truncated to fit handoff token budget)";
  }
  return capsule;
}

function applyEvent(
  event: AgentEvent,
  files: Map<string, "created" | "modified" | "deleted">,
  commands: string[],
  lastTexts: string[]
): void {
  switch (event.type) {
    case "FileChanged":
      files.set(event.path, event.action);
      break;
    case "CommandExecuted":
      commands.push(`${event.command} (exit ${event.exitCode ?? "?"})`);
      break;
    case "TextDelta": {
      const text = event.text.trim();
      // Handoff echoes are transcripts of a previous capsule, not fresh
      // agent notes; including them would make capsules snowball in size.
      if (text && !text.includes("Received handoff:")) {
        lastTexts.push(text.length > 300 ? text.slice(0, 300) + "…" : text);
      }
      break;
    }
  }
}

function readMemoryFile(root: string, name: string): string | null {
  try {
    const content = fs.readFileSync(path.join(root, name), "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}
