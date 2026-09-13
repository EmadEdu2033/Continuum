#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultConfig, loadConfig, writeConfig } from "./config.js";
import { Store } from "./store.js";
import { createCheckpoint } from "./checkpoint.js";
import { Supervisor } from "./supervisor.js";
import { buildAdapters } from "./adapters/registry.js";

const program = new Command();
program.name("continuum").description("Provider-neutral continuity runtime for AI coding agents").version("0.1.0");

function projectRoot(): string {
  return process.cwd();
}

program
  .command("init")
  .description("Initialize Continuum in the current repository")
  .action(() => {
    const root = projectRoot();
    writeConfig(root, defaultConfig(path.basename(root)));
    const cdir = path.join(root, ".continuum");
    for (const f of ["decisions.md", "constraints.md", "project.md"]) {
      const p = path.join(cdir, f);
      if (!fs.existsSync(p)) fs.writeFileSync(p, "", "utf8");
    }
    fs.writeFileSync(
      path.join(cdir, "current-task.json"),
      JSON.stringify({ task: null, provider: null, status: "idle" }, null, 2),
      "utf8"
    );
    console.log(`Continuum initialized in ${cdir}`);
  });

program
  .command("doctor")
  .description("Check provider availability")
  .option("--mock", "check mock providers instead of real CLIs")
  .action(async (opts) => {
    const root = projectRoot();
    const adapters = buildAdapters(root, loadConfig(root), { real: !opts.mock });
    for (const [id, adapter] of adapters) {
      const installed = await adapter.detect();
      const health = await adapter.health();
      console.log(
        `${id.padEnd(14)} installed=${installed} auth=${health.authenticated} state=${health.state} version=${health.version ?? "?"}`
      );
    }
  });

program
  .command("run")
  .description("Run a task through the provider chain")
  .argument("<task>", "task description")
  .option("--mock", "run against mock providers instead of real CLIs")
  .action(async (task: string, opts) => {
    const root = projectRoot();
    const store = new Store(root);
    try {
      const supervisor = new Supervisor(
        buildAdapters(root, loadConfig(root), { real: !opts.mock }),
        loadConfig(root),
        store,
        root,
        { onLog: (line) => console.log(line) }
      );
      const result = await supervisor.run(task);
      console.log(`\nResult: ${result.status} (last provider: ${result.providerId})`);
    } catch (err: any) {
      console.error(err?.message ?? String(err));
      process.exitCode = 1;
    } finally {
      store.close();
    }
  });

program
  .command("status")
  .description("Show current task, providers and context state")
  .action(() => {
    const root = projectRoot();
    const store = new Store(root);
    const task = store.getActiveTask();
    console.log("Task:", task ? `${task.id}: ${task.description} (${task.status}, provider=${task.current_provider})` : "(none)");
    for (const p of store.getProviders()) {
      console.log(`${p.id.padEnd(14)} ${p.state}${p.available_at ? ` (available at ${p.available_at})` : ""}`);
    }
    const events = store.readEvents();
    const cp = store.getLatestCheckpoint();
    console.log(`Events: ${events.length}  Latest checkpoint: ${cp ? `#${cp.id}` : "(none)"}`);
    store.close();
  });

program
  .command("providers")
  .description("List provider states")
  .action(() => {
    const store = new Store(projectRoot());
    for (const p of store.getProviders()) console.log(`${p.id}: ${p.state}`);
    store.close();
  });

program
  .command("checkpoint")
  .description("Create a checkpoint of the current workspace state")
  .action(() => {
    const root = projectRoot();
    const store = new Store(root);
    const cp = createCheckpoint(store, root, "manual");
    console.log(`Checkpoint #${cp.id} created (${cp.filesChanged.length} changed files).`);
    store.close();
  });

program
  .command("handoff")
  .description("Print the latest handoff capsule")
  .action(() => {
    const file = path.join(projectRoot(), ".continuum", "handoffs", "latest.txt");
    console.log(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "(no handoff yet)");
  });

program
  .command("memory")
  .description("Show durable project memory files")
  .action(() => {
    const cdir = path.join(projectRoot(), ".continuum");
    for (const f of ["project.md", "decisions.md", "constraints.md"]) {
      const p = path.join(cdir, f);
      const content = fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
      console.log(`--- ${f} ---\n${content || "(empty)"}\n`);
    }
  });

program
  .command("logs")
  .description("Tail the normalized event log")
  .option("-n, --lines <n>", "number of lines", "20")
  .action((opts) => {
    const store = new Store(projectRoot());
    const events = store.readEvents().slice(-Number(opts.lines));
    for (const e of events) console.log(`${e.ts} [${e.type}]`, summarize(e));
    store.close();
  });

program
  .command("resume")
  .description("Resume the paused active task")
  .option("--mock", "resume against mock providers instead of real CLIs")
  .action(async (opts) => {
    const root = projectRoot();
    const store = new Store(root);
    const task = store.getActiveTask();
    if (!task) {
      console.log("No active task to resume.");
      store.close();
      return;
    }
    // The paused row is superseded by the fresh run's task row.
    store.updateTask(task.id, { status: "resumed" });
    try {
      const supervisor = new Supervisor(
        buildAdapters(root, loadConfig(root), { real: !opts.mock }),
        loadConfig(root),
        store,
        root,
        { onLog: (line) => console.log(line) }
      );
      const result = await supervisor.run(task.description);
      console.log(`\nResult: ${result.status}`);
    } catch (err: any) {
      console.error(err?.message ?? String(err));
      process.exitCode = 1;
    } finally {
      store.close();
    }
  });

program
  .command("start")
  .description("Interactive guided run: pick start provider, then auto-failover")
  .option("--mock", "use mock providers instead of real CLIs")
  .action(async (opts) => {
    const { createInterface } = await import("node:readline/promises");
    const { stdin: input, stdout: output } = await import("node:process");
    const rl = createInterface({ input, output });
    try {
      const root = projectRoot();
      const config = loadConfig(root);
      const adapters = buildAdapters(root, config, { real: !opts.mock });
      console.log("\n=== CONTINUUM ===  Agent can stop. Context doesn't.\n");
      console.log("Providers (checked now, no tokens spent on standby):");
      const rows: Array<{ id: string; ok: boolean }> = [];
      for (const id of config.routing.order) {
        const a = adapters.get(id);
        const ok = a ? await a.detect() : false;
        rows.push({ id, ok });
        console.log(`  ${rows.length}. ${id.padEnd(12)} ${ok ? "READY" : "NOT INSTALLED"}`);
      }
      const task = (await rl.question("\nTask? (e.g. Build auth and test it)\n> ")).trim();
      if (!task) {
        console.log("No task given. Exit.");
        return;
      }
      const pickRaw = (await rl.question(`\nStart with which? [1-${rows.length}] default=1 (auto-failover through rest in order)\n> `)).trim();
      const pick = Math.min(Math.max(parseInt(pickRaw || "1", 10) || 1, 1), rows.length);
      const first = rows[pick - 1].id;
      config.routing.order = [first, ...config.routing.order.filter((p) => p !== first)];
      writeConfig(root, config);
      if (!rows[pick - 1].ok && !opts.mock) {
        console.log(`Note: ${first} not installed — supervisor will skip it automatically.`);
      }
      console.log(`\nOrder: ${config.routing.order.join(" -> ")}`);
      console.log(`Running. On quota/limit: checkpoint + handoff capsule + next provider.\n`);
      const store = new Store(root);
      try {
        const supervisor = new Supervisor(
          buildAdapters(root, config, { real: !opts.mock }),
          config,
          store,
          root,
          { onLog: (line) => console.log(line) }
        );
        const result = await supervisor.run(task);
        console.log(`\nResult: ${result.status} (last provider: ${result.providerId})`);
        console.log(`Next: status | handoff | logs | resume`);
      } finally {
        store.close();
      }
    } finally {
      rl.close();
    }
  });

program
  .command("switch")
  .description("Reorder routing to start with the given provider")
  .argument("<provider>", "provider id")
  .action((provider: string) => {
    const root = projectRoot();
    const config = loadConfig(root);
    if (!config.routing.order.includes(provider)) {
      console.error(`Unknown provider "${provider}". Configured: ${config.routing.order.join(", ")}`);
      process.exit(1);
    }
    config.routing.order = [provider, ...config.routing.order.filter((p) => p !== provider)];
    writeConfig(root, config);
    console.log(`Routing order is now: ${config.routing.order.join(" -> ")}`);
  });

function summarize(e: any): string {
  switch (e.type) {
    case "TextDelta":
      return e.text.trim();
    case "FileChanged":
      return `${e.path} (${e.action})`;
    case "CommandExecuted":
      return `${e.command} (exit ${e.exitCode ?? "?"})`;
    case "AgentError":
      return `[${e.error}] ${e.message}`;
    case "CheckpointCreated":
      return `checkpoint #${e.checkpointId}`;
    case "SessionStarted":
      return `session ${e.sessionId} (${e.providerId})`;
    default:
      return "";
  }
}

program.parseAsync();
