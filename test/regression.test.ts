import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Supervisor } from "../src/supervisor.js";
import { Store } from "../src/store.js";
import { defaultConfig, loadConfig, writeConfig } from "../src/config.js";
import { MockProvider } from "../src/adapters/mock.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "continuum-fix-"));
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

describe("regression fixes", () => {
  it("handoff capsule only includes events from the current task, not history", async () => {
    const config = defaultConfig("t");
    config.routing.order = ["provider-a", "provider-b"];

    const store = new Store(root);
    const adapters = new Map();

    // Run task #1 to completion first: it touches old-task.txt.
    adapters.set("provider-a", new MockProvider({ id: "provider-a", script: [
      { kind: "writeFile", path: "old-task.txt", content: "first task\n" },
    ]}));
    const sup1 = new Supervisor(adapters, config, store, root);
    await sup1.run("first task");

    // Task #2: provider-a fails after touching new-task.txt; capsule must
    // mention new-task.txt but never old-task.txt.
    adapters.set("provider-a", new MockProvider({ id: "provider-a", script: [
      { kind: "writeFile", path: "new-task.txt", content: "second task\n" },
      { kind: "fail", error: "QUOTA_EXHAUSTED", message: "limit" },
    ]}));
    adapters.set("provider-b", new MockProvider({ id: "provider-b", script: [
      { kind: "say", text: "done" },
    ]}));
    const sup2 = new Supervisor(adapters, config, store, root);
    const result = await sup2.run("second task");
    expect(result.status).toBe("completed");

    const capsule = fs.readFileSync(path.join(store.handoffsDir, "latest.txt"), "utf8");
    expect(capsule).toContain("new-task.txt");
    expect(capsule).not.toContain("old-task.txt");
    expect(capsule).not.toContain("first task\n");
    store.close();
  });

  it("continuum switch preserves per-provider config (models)", () => {
    writeConfig(root, {
      ...defaultConfig("t"),
      providers: { opencode: { model: "opencode/nemotron-3.5-lightning-free" } },
    });
    const config = loadConfig(root);
    expect(config.providers?.opencode?.model).toBe("opencode/nemotron-3.5-lightning-free");

    // Simulate `continuum switch opencode`: rewrite config with new order.
    config.routing.order = ["opencode", ...config.routing.order.filter((p) => p !== "opencode")];
    writeConfig(root, config);

    const reloaded = loadConfig(root);
    expect(reloaded.routing.order[0]).toBe("opencode");
    expect(reloaded.providers?.opencode?.model).toBe("opencode/nemotron-3.5-lightning-free");
  });

  it("checkpoints exclude .continuum state noise from git status", async () => {
    // git status needs an actual repository.
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, "real-change.txt"), "real\n", "utf8");
    const store = new Store(root);
    const cp = (await import("../src/checkpoint.js")).createCheckpoint(store, root, "test");
    expect(cp.filesChanged).toContain("real-change.txt");
    expect(cp.filesChanged.some((f) => f.includes(".continuum"))).toBe(false);
    store.close();
  });

  it("retries within the same task resume the provider's native session", async () => {
    const config = defaultConfig("t");
    config.routing.order = ["provider-a"];
    config.failover.temporary_rate_limit.max_attempts = 2;
    const adapters = new Map();
    adapters.set("provider-a", new MockProvider({ id: "provider-a", script: [
      { kind: "fail", error: "TEMP_RATE_LIMIT", message: "429" },
      { kind: "writeFile", path: "done.txt", content: "ok\n" },
    ]}));

    const store = new Store(root);
    const supervisor = new Supervisor(adapters, config, store, root);
    const result = await supervisor.run("retry task");
    expect(result.status).toBe("completed");

    // Both attempts (SessionStarted per attempt) must carry the same id.
    const starts = store
      .readEvents()
      .filter((e) => e.type === "SessionStarted" && e.providerId === "provider-a");
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(starts.map((s: any) => s.sessionId)).size).toBe(1);
    store.close();
  });

  it("never resumes a session saved for a different task", async () => {
    const config = defaultConfig("t");
    config.routing.order = ["provider-a", "provider-b"];
    const adapters = new Map();

    const store = new Store(root);
    // Task 1: provider-a completes and its session id is stored.
    adapters.set("provider-a", new MockProvider({ id: "provider-a", script: [
      { kind: "say", text: "first" },
    ]}));
    await new Supervisor(adapters, config, store, root).run("first task");
    const firstSession = store.readEvents().find(
      (e) => e.type === "SessionStarted" && e.providerId === "provider-a"
    )!;

    // Task 2 (different text): provider-a must START FRESH, not resume task 1's session.
    adapters.set("provider-a", new MockProvider({ id: "provider-a", script: [
      { kind: "fail", error: "QUOTA_EXHAUSTED", message: "limit" },
    ]}));
    adapters.set("provider-b", new MockProvider({ id: "provider-b", script: [
      { kind: "say", text: "done" },
    ]}));
    await new Supervisor(adapters, config, store, root).run("second task");

    const secondSession = store
      .readEvents()
      .filter((e: any) => e.type === "SessionStarted" && e.providerId === "provider-a" && e.taskId === 2)[0];
    expect(secondSession).toBeTruthy();
    expect((secondSession as any).sessionId).not.toBe((firstSession as any).sessionId);
    store.close();
  });

  it("mock mode never invents idle mocks for unscripted providers", async () => {
    // Only scripted providers may exist; an empty/idle mock would "complete"
    // tasks while doing nothing.
    const { buildAdapters } = await import("../src/adapters/registry.js");
    fs.writeFileSync(
      path.join(root, ".continuum", "mock-providers.json"),
      JSON.stringify([{ id: "codex", script: [{ kind: "say", text: "hi" }] }]),
      "utf8"
    );
    const config = defaultConfig("t"); // order: codex, claude, opencode, antigravity
    const adapters = buildAdapters(root, config, { real: false });
    expect([...adapters.keys()]).toEqual(["codex"]);
  });
});
