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
});
