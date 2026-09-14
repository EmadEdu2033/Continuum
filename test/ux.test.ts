import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store.js";
import { Supervisor } from "../src/supervisor.js";
import { defaultConfig } from "../src/config.js";
import { CodexAdapter } from "../src/adapters/codex.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "continuum-ux-"));
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

describe("UX helpers", () => {
  it("getLatestTask sees finished tasks for `status`", () => {
    const store = new Store(root);
    const id = store.createTask("done job");
    store.updateTask(id, { status: "completed", currentProvider: "codex", finishedAt: new Date().toISOString() });
    expect(store.getActiveTask()).toBeUndefined();
    const latest = store.getLatestTask();
    expect(latest?.description).toBe("done job");
    expect(latest?.status).toBe("completed");
    store.close();
  });

  it("empty routing fails with an actionable message", async () => {
    const store = new Store(root);
    const supervisor = new Supervisor(new Map(), defaultConfig("t"), store, root);
    await expect(supervisor.run("x")).rejects.toThrow(/continuum doctor/);
    await expect(supervisor.run("x")).rejects.toThrow(/mock-providers\.json/);
    store.close();
  });

  it("codex auth probe never throws and reports honestly", async () => {
    const adapter = new CodexAdapter();
    const result = await adapter.checkAuth();
    expect(result === null || typeof result.ok === "boolean").toBe(true);
    if (await adapter.detect()) {
      // Installed: the probe must give a definitive answer.
      expect(result).not.toBeNull();
    }
  });
});
