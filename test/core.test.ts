import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceLock } from "../src/lock.js";
import { Supervisor } from "../src/supervisor.js";
import { Store } from "../src/store.js";
import { defaultConfig } from "../src/config.js";
import { MockProvider } from "../src/adapters/mock.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "continuum-core-"));
});

afterEach(() => {
  // Windows keeps locked SQLite files around briefly; retry the cleanup.
  for (let i = 0; i < 3; i++) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      continue;
    }
  }
});

describe("WorkspaceLock", () => {
  it("grants write ownership to exactly one provider at a time", () => {
    const lock = new WorkspaceLock(root);
    lock.acquire("codex");
    expect(lock.holder()).toBe("codex");

    expect(() => lock.acquire("claude")).toThrow(/held by "codex"/);

    // Re-acquire by the same holder is a no-op.
    lock.acquire("codex");
    expect(lock.holder()).toBe("codex");

    lock.release("codex");
    expect(lock.holder()).toBeNull();

    // After release another provider can take over.
    lock.acquire("claude");
    expect(lock.holder()).toBe("claude");
  });

  it("survives process restarts by reading the lock file", () => {
    const a = new WorkspaceLock(root);
    a.acquire("codex");
    // A fresh instance, as another process would see it.
    const b = new WorkspaceLock(root);
    expect(b.holder()).toBe("codex");
    expect(() => b.acquire("opencode")).toThrow(/held by "codex"/);
  });
});

describe("failover edge cases", () => {
  it("pauses the task on AUTH_REQUIRED instead of failing over", async () => {
    const config = defaultConfig("t");
    config.routing.order = ["provider-a", "provider-b"];
    const adapters = new Map();
    adapters.set("provider-a", new MockProvider({ id: "provider-a", script: [
      { kind: "say", text: "need login" },
      { kind: "fail", error: "AUTH_REQUIRED", message: "token expired" },
    ]}));
    adapters.set("provider-b", new MockProvider({ id: "provider-b", script: [
      { kind: "say", text: "should never run" },
    ]}));

    const store = new Store(root);
    const supervisor = new Supervisor(adapters, config, store, root);
    const result = await supervisor.run("auth task");

    expect(result.status).toBe("exhausted");
    const states = Object.fromEntries(store.getProviders().map((p) => [p.id, p.state]));
    expect(states["provider-a"]).toBe("AUTH_REQUIRED");
    expect(states["provider-b"]).toBeUndefined(); // never activated

    // Task stays paused so `continuum resume` can pick it up later.
    const task = store.getActiveTask();
    expect(task?.status).toBe("paused");

    // Lock was released even though the provider is stuck in AUTH_REQUIRED.
    expect(fs.existsSync(path.join(root, ".continuum", "workspace.lock"))).toBe(false);
    store.close();
  });

  it("treats TEMP_RATE_LIMIT as transient and moves on without marking EXHAUSTED", async () => {
    const config = defaultConfig("t");
    config.routing.order = ["provider-a", "provider-b"];
    config.failover.temporary_rate_limit.max_attempts = 0; // no retries: move on immediately
    const adapters = new Map();
    adapters.set("provider-a", new MockProvider({ id: "provider-a", script: [
      { kind: "fail", error: "TEMP_RATE_LIMIT", message: "429 slow down" },
    ]}));
    adapters.set("provider-b", new MockProvider({ id: "provider-b", script: [
      { kind: "say", text: "done here" },
    ]}));

    const store = new Store(root);
    const supervisor = new Supervisor(adapters, config, store, root);
    const result = await supervisor.run("transient task");

    expect(result.status).toBe("completed");
    expect(result.providerId).toBe("provider-b");
    const states = Object.fromEntries(store.getProviders().map((p) => [p.id, p.state]));
    expect(states["provider-a"]).toBe("COOLDOWN");
    store.close();
  });

  it("retries the same provider on TEMP_RATE_LIMIT and succeeds on a later attempt", async () => {
    const config = defaultConfig("t");
    config.routing.order = ["provider-a"];
    config.failover.temporary_rate_limit.max_attempts = 2;
    const adapters = new Map();
    adapters.set("provider-a", new MockProvider({ id: "provider-a", script: [
      { kind: "say", text: "about to be rate limited" },
      { kind: "fail", error: "TEMP_RATE_LIMIT", message: "429 slow down" },
      { kind: "writeFile", path: "retried.txt", content: "second attempt worked\n" },
    ]}));

    const store = new Store(root);
    const supervisor = new Supervisor(adapters, config, store, root);
    const result = await supervisor.run("retry task");

    // The retry on the SAME provider finished the task.
    expect(result.status).toBe("completed");
    expect(result.providerId).toBe("provider-a");
    expect(fs.readFileSync(path.join(root, "retried.txt"), "utf8")).toContain("second attempt");
    const states = Object.fromEntries(store.getProviders().map((p) => [p.id, p.state]));
    expect(states["provider-a"]).toBe("READY");
    store.close();
  });

  it("captures a checkpoint even when the agent dies mid-file-write", async () => {
    const config = defaultConfig("t");
    config.routing.order = ["provider-a", "provider-b"];
    const adapters = new Map();
    adapters.set("provider-a", new MockProvider({ id: "provider-a", script: [
      { kind: "writeFile", path: "half-done.ts", content: "export const x = 1;\n" },
      { kind: "fail", error: "QUOTA_EXHAUSTED", message: "died right after writing" },
    ]}));
    adapters.set("provider-b", new MockProvider({ id: "provider-b", script: [
      { kind: "say", text: "recovered" },
    ]}));

    const store = new Store(root);
    const supervisor = new Supervisor(adapters, config, store, root);
    const result = await supervisor.run("fragile task");

    expect(result.status).toBe("completed");
    // The half-written file is on disk and recorded in the checkpoint.
    expect(fs.readFileSync(path.join(root, "half-done.ts"), "utf8")).toContain("x = 1");
    const events = store.readEvents();
    const checkpointEvent = events.find((e) => e.type === "CheckpointCreated");
    expect(checkpointEvent).toBeTruthy();
    const handoff = fs.readFileSync(path.join(store.handoffsDir, "latest.txt"), "utf8");
    expect(handoff).toContain("half-done.ts");
    store.close();
  });
});
