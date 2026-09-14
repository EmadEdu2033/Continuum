import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store.js";
import { plainEvents } from "./helpers.js";
import { compactEvents, compactTask } from "../src/compactor.js";
import { planRoute } from "../src/routing.js";
import { indexProjectMemory, semanticSearch } from "../src/memory.js";
import { defaultConfig, writeConfig, loadConfig } from "../src/config.js";
import { renderFrame } from "../src/tui/render.js";
import type { SupervisorSnapshot } from "../src/telemetry.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "continuum-roadmap-"));
  fs.mkdirSync(path.join(root, ".continuum"), { recursive: true });
});

afterEach(() => {
  for (let i = 0; i < 3; i++) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      continue;
    }
  }
});

describe("smart routing", () => {
  it("ordered mode follows the configured order verbatim", () => {
    const order = planRoute({
      configured: ["codex", "claude", "opencode"],
      available: new Set(["codex", "claude", "opencode"]),
      states: new Map(),
      failures: new Map(),
      mode: "ordered",
    }).map((d) => d.id);
    expect(order).toEqual(["codex", "claude", "opencode"]);
  });

  it("smart mode keeps priority but demotes cooldown/failing providers", () => {
    const order = planRoute({
      configured: ["codex", "claude", "opencode"],
      available: new Set(["codex", "claude", "opencode"]),
      states: new Map([
        ["codex", "COOLDOWN"],
        ["claude", "READY"],
        ["opencode", "READY"],
      ]),
      failures: new Map([["codex", 3]]),
      mode: "smart",
    }).map((d) => d.id);
    // codex demoted below the healthy ones, which keep their priority.
    expect(order).toEqual(["claude", "opencode", "codex"]);
  });

  it("smart mode skips exhausted providers when a healthy one exists", () => {
    const order = planRoute({
      configured: ["codex", "claude"],
      available: new Set(["codex", "claude"]),
      states: new Map([["codex", "EXHAUSTED"], ["claude", "READY"]]),
      failures: new Map(),
      mode: "smart",
    }).map((d) => d.id);
    expect(order).toEqual(["claude"]);
  });
});

describe("context compactor", () => {
  it("sessions are summarized and handoff echoes are excluded", () => {
    const events = plainEvents();
    const { text, sessions } = compactEvents(events, 200);
    expect(sessions.length).toBe(2);
    expect(text).toContain("codex");
    expect(text).toContain("claude");
    expect(text).toContain("src/auth.ts");
    expect(text).not.toContain("Received handoff");
    expect(text).toContain("import failed");
  });

  it("compactTask persists a summary retrievable later", () => {
    const store = new Store(root);
    const taskId = store.createTask("build auth");
    for (const e of plainEvents()) store.appendEvent(taskId, e);
    const res = compactTask(store, taskId, 300);
    expect(res.tokensAfter).toBeLessThan(res.tokensBefore);
    expect(store.getSummary(taskId)).toContain("codex");
    store.close();
  });
});

describe("semantic memory", () => {
  it("finds relevant decisions and summaries across the project", () => {
    const store = new Store(root);
    fs.writeFileSync(
      path.join(root, ".continuum", "decisions.md"),
      "Decision: refresh tokens stored in httpOnly cookies.",
      "utf8"
    );
    const taskId = store.createTask("payment webhook");
    store.appendEvent(taskId, {
      type: "TextDelta",
      text: "The payment webhook intermittently fails on Windows.",
      at: new Date().toISOString(),
    });
    compactTask(store, taskId);

    const docs = indexProjectMemory(store, root);
    expect(docs).toBeGreaterThanOrEqual(2);
    const hits = semanticSearch(store, root, "webhook");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.snippet.toLowerCase().includes("webhook"))).toBe(true);
    const cookie = semanticSearch(store, root, "cookies");
    expect(cookie.length).toBeGreaterThan(0);
    store.close();
  });
});

describe("config round-trip", () => {
  it("preserves routing mode, memory.semantic and providers", () => {
    writeConfig(root, {
      ...defaultConfig("t"),
      routing: { mode: "smart", order: ["claude", "codex"] },
      providers: { opencode: { model: "opencode/x" } },
      memory: { ...defaultConfig("t").memory, semantic: false },
    });
    const loaded = loadConfig(root);
    expect(loaded.routing.mode).toBe("smart");
    expect(loaded.routing.order).toEqual(["claude", "codex"]);
    expect(loaded.providers?.opencode?.model).toBe("opencode/x");
    expect(loaded.memory.semantic).toBe(false);
  });
});

describe("TUI renderer", () => {
  const snapshot: SupervisorSnapshot = {
    task: "Build authentication",
    taskId: 1,
    order: ["codex", "claude", "opencode"],
    index: 1,
    providerId: "claude",
    status: "running",
    filesTouched: 4,
    commandsRun: 2,
    startedAt: Date.now() - 60000,
    activeSince: Date.now() - 30000,
    lastError: null,
    checkpointId: "3",
    handoffCount: 1,
    message: "",
  };

  it("draws a full dashboard on a wide terminal", () => {
    const frame = renderFrame({
      snapshot,
      providers: [
        { id: "codex", state: "EXHAUSTED" },
        { id: "claude", state: "ACTIVE" },
        { id: "opencode", state: "READY" },
      ],
      logs: ["claude is now the active writer", "Compiling..."],
      size: { rows: 30, cols: 100 },
      spinner: 0,
      project: "demo",
      mode: "live",
      finished: false,
    });
    expect(frame).toContain("CONTINUUM");
    expect(frame).toContain("Providers");
    expect(frame).toContain("claude");
    expect(frame).toContain("Handoff chain");
    expect(frame).toContain("quit");
    expect(frame.split("\n").length).toBeLessThanOrEqual(30);
  });

  it("degrades gracefully on a tiny terminal", () => {
    const frame = renderFrame({
      snapshot,
      providers: [{ id: "codex", state: "READY" }],
      logs: [],
      size: { rows: 12, cols: 60 },
      spinner: 3,
      project: "demo",
      mode: "mock",
      finished: false,
    });
    expect(typeof frame).toBe("string");
    expect(frame.split("\n").length).toBeLessThanOrEqual(12);
  });
});
