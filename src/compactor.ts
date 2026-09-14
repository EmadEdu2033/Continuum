import type { AgentEvent } from "./types.js";
import type { Store } from "./store.js";

/** Rough token estimate; ~4 characters per token is good enough for budgets. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface CompactResult {
  taskId: number;
  text: string;
  events: number;
  tokensBefore: number;
  tokensAfter: number;
}

interface SessionBucket {
  provider: string;
  sessionId: string;
  texts: string[];
  files: Map<string, string>;
  commands: string[];
  errors: string[];
}

/**
 * Hierarchical, deterministic compaction: raw events → per-session summaries →
 * one task memory. No LLM required, so it is safe to run inside the control
 * path. (An LLM summarizer can be layered on later behind the same interface.)
 */
export function compactEvents(events: AgentEvent[], maxTokens = 1200): { text: string; sessions: SessionBucket[] } {
  const sessions: SessionBucket[] = [];
  let current: SessionBucket | null = null;

  for (const e of events) {
    if (e.type === "SessionStarted") {
      current = { provider: e.providerId, sessionId: e.sessionId, texts: [], files: new Map(), commands: [], errors: [] };
      sessions.push(current);
      continue;
    }
    if (!current) {
      current = { provider: "?", sessionId: "?", texts: [], files: new Map(), commands: [], errors: [] };
      sessions.push(current);
    }
    switch (e.type) {
      case "TextDelta": {
        const t = e.text.trim();
        // Skip echoed handoff capsules: they are prior context, not new work.
        if (t && !t.includes("Received handoff") && !t.includes("=== CONTINUUM HANDOFF ===")) {
          current.texts.push(t.length > 240 ? t.slice(0, 240) + "…" : t);
        }
        break;
      }
      case "FileChanged":
        current.files.set(e.path, e.action);
        break;
      case "CommandExecuted":
        current.commands.push(`${e.command} (exit ${e.exitCode ?? "?"})`);
        break;
      case "AgentError":
        current.errors.push(`${e.error}: ${e.message}`);
        break;
    }
  }

  const parts: string[] = [];
  for (const [i, s] of sessions.entries()) {
    const files = [...s.files.entries()].map(([p, a]) => `${p} (${a})`);
    const lines = [
      `Session ${i + 1} — ${s.provider}`,
      files.length ? `  files: ${dedupe(files).slice(0, 20).join(", ")}` : "  files: (none)",
      s.commands.length ? `  commands: ${s.commands.slice(-5).join("; ")}` : "  commands: (none)",
      s.errors.length ? `  errors: ${dedupe(s.errors).slice(0, 5).join(" | ")}` : "",
      s.texts.length ? `  notes: ${s.texts.slice(-4).join(" ")}` : "",
    ].filter(Boolean);
    parts.push(lines.join("\n"));
  }

  let text = parts.join("\n");
  const budget = maxTokens * 4;
  if (text.length > budget) text = text.slice(0, budget) + "\n…(compacted)";
  return { text, sessions };
}

export function compactTask(store: Store, taskId: number, maxTokens = 1200): CompactResult {
  const events = store.readEvents().filter((e) => e.taskId === taskId);
  const raw = JSON.stringify(events);
  const { text } = compactEvents(events, maxTokens);
  store.saveSummary(taskId, text);
  return {
    taskId,
    text,
    events: events.length,
    tokensBefore: estimateTokens(raw),
    tokensAfter: estimateTokens(text),
  };
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
