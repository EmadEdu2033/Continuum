import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Supervisor } from "../src/supervisor.js";
import { Store } from "../src/store.js";
import { defaultConfig } from "../src/config.js";
import { MockProvider } from "../src/adapters/mock.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "continuum-test-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("core acceptance scenario: QUOTA_EXHAUSTED -> checkpoint -> handoff -> continue", () => {
  it("moves an interrupted task from provider A to provider B while retaining workspace state", async () => {
    const config = defaultConfig("test-project");
    config.routing.order = ["provider-a", "provider-b"];

    const store = new Store(root);
    fs.writeFileSync(
      path.join(store.root, "decisions.md"),
      "Decision: use plain functions, no classes for utils.",
      "utf8"
    );
    fs.writeFileSync(
      path.join(store.root, "constraints.md"),
      "Constraint: do not change the public REST API.",
      "utf8"
    );

    const logs: string[] = [];
    const adapters = new Map();
    adapters.set(
      "provider-a",
      new MockProvider({
        id: "provider-a",
        script: [
          { kind: "say", text: "Starting calculator implementation." },
          { kind: "writeFile", path: "src/calc.ts", content: "export const add = (a: number, b: number) => a + b;\n" },
          { kind: "writeFile", path: "src/main.ts", content: 'import { add } from "./calc.js";\nconsole.log(add(1, 2));\n' },
          { kind: "run", command: "echo ran-tests" },
          { kind: "fail", error: "QUOTA_EXHAUSTED", message: "usage limit reached mid-task" },
        ],
      })
    );
    adapters.set(
      "provider-b",
      new MockProvider({
        id: "provider-b",
        script: [
          { kind: "say", text: "Resuming from handoff." },
          { kind: "writeFile", path: "src/calc.ts", content: "export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\n" },
          { kind: "writeFile", path: "tests/calc.test.txt", content: "add: pass\nsub: pass\n" },
          { kind: "say", text: "All tests passing. Task complete." },
        ],
      })
    );

    const supervisor = new Supervisor(adapters, config, store, root, { onLog: (l) => logs.push(l) });
    const result = await supervisor.run("Build a calculator and test it");

    // Provider B completed the task.
    expect(result.status).toBe("completed");
    expect(result.providerId).toBe("provider-b");

    // Files written by A survived and B continued on top of them.
    expect(fs.readFileSync(path.join(root, "src/calc.ts"), "utf8")).toContain("export const sub");
    expect(fs.existsSync(path.join(root, "src/main.ts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "tests/calc.test.txt"))).toBe(true);

    // A checkpoint was recorded after A died.
    const cp = store.getLatestCheckpoint();
    expect(cp).toBeTruthy();
    expect(cp.provider_id).toBe("provider-b"); // final checkpoint after B completed

    // A handoff capsule exists and carries the essentials.
    const handoff = fs.readFileSync(path.join(store.handoffsDir, "latest.txt"), "utf8");
    expect(handoff).toContain("Build a calculator and test it");
    expect(handoff).toContain("provider-a");
    expect(handoff).toContain("QUOTA_EXHAUSTED");
    expect(handoff).toContain("src/calc.ts");
    expect(handoff).toContain("do not change the public REST API");
    expect(handoff).toContain("Continue the existing task");

    // Provider states: A exhausted, B finished READY.
    const states = Object.fromEntries(store.getProviders().map((p) => [p.id, p.state]));
    expect(states["provider-a"]).toBe("EXHAUSTED");
    expect(states["provider-b"]).toBe("READY");

    // The workspace lock was released at the end.
    expect(fs.existsSync(path.join(root, ".continuum", "workspace.lock"))).toBe(false);

    // Normalized events were logged throughout.
    const types = store.readEvents().map((e) => e.type);
    for (const t of [
      "SessionStarted",
      "TextDelta",
      "FileChanged",
      "CommandExecuted",
      "AgentError",
      "CheckpointCreated",
      "SessionFinished",
    ]) {
      expect(types).toContain(t);
    }

    // B actually received the handoff capsule text.
    const bStart = store.readEvents().find((e) => e.type === "SessionStarted" && e.providerId === "provider-b");
    expect(bStart).toBeTruthy();
    const bHandoffNote = store.readEvents().find((e) => e.type === "TextDelta" && e.text.includes("Received handoff"));
    expect(bHandoffNote?.text).toContain("QUOTA_EXHAUSTED");

    // The task is marked completed.
    expect(store.getActiveTask()).toBeUndefined();

    store.close();
  });

  it("hands off to B then reports exhaustion when every provider dies", async () => {
    const config = defaultConfig("test-project");
    config.routing.order = ["provider-a", "provider-b"];
    const adapters = new Map();
    for (const id of ["provider-a", "provider-b"]) {
      adapters.set(
        id,
        new MockProvider({
          id,
          script: [{ kind: "fail", error: "QUOTA_EXHAUSTED", message: "no quota" }],
        })
      );
    }
    const store = new Store(root);
    const supervisor = new Supervisor(adapters, config, store, root);
    const result = await supervisor.run("doomed task");
    expect(result.status).toBe("exhausted");
    expect(fs.existsSync(path.join(store.handoffsDir, "latest.txt"))).toBe(true);
    store.close();
  });
});
