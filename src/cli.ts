#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { defaultConfig, loadConfig, writeConfig } from "./config.js";
import { Store } from "./store.js";
import { createCheckpoint } from "./checkpoint.js";
import { Supervisor, fmtElapsed } from "./supervisor.js";
import type { ContinuumConfig } from "./config.js";
import { buildAdapters } from "./adapters/registry.js";
import { Dashboard } from "./tui/app.js";
import { isTty } from "./tui/term.js";
import { compactTask } from "./compactor.js";
import { semanticSearch } from "./memory.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version?: string; engines?: { node?: string } };
const MIN_NODE = pkg.engines?.node ?? ">=23.4";

const program = new Command();
program.name("continuum").description("Provider-neutral continuity runtime for AI coding agents").version(pkg.version ?? "0.1.0");

function projectRoot(): string {
  return process.cwd();
}

const LOGIN_HINTS: Record<string, string> = {
  codex: "codex login",
  claude: "claude login",
};

function loginHint(id: string): string {
  return LOGIN_HINTS[id] ?? `authenticate ${id} (see its own docs)`;
}

function lastAgentError(store: Store): { error: string; message: string } | null {
  const events = store.readEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as any;
    if (e?.type === "AgentError") return { error: e.error, message: e.message };
  }
  return null;
}

function printResultSummary(store: Store, result: { taskId: number; providerId: string; status: string }, elapsedMs: number): void {
  const cp = store.getLatestCheckpoint();
  const handoffPath = path.join(store.handoffsDir, "latest.txt");
  const hasHandoff = fs.existsSync(handoffPath);
  console.log(`\n────────────────────────`);
  console.log(`Result: ${result.status} in ${fmtElapsed(elapsedMs)} (last provider: ${result.providerId})`);
  console.log(`Checkpoint: ${cp ? `#${cp.id}` : "(none)"}   Handoff: ${hasHandoff ? "latest.txt" : "(none needed)"}`);
  const err = result.status === "exhausted" ? lastAgentError(store) : null;
  if (result.status === "completed") {
    console.log(`Next: handoff (review capsule) | logs (transcript) | start (new task)`);
  } else if (err?.error === "AUTH_REQUIRED") {
    console.log(`Next: ${loginHint(result.providerId)}, then: continuum resume`);
  } else if (err) {
    console.log(`Next: continuum resume (retry) | switch <provider> (change starter) | logs (details)`);
  } else {
    console.log(`Next: continuum resume | continuum status`);
  }
}

/**
 * Runs a task and renders either the live dashboard (TTY) or plain logs.
 * Shared by `run`, `start` and `resume`.
 */
async function executeRun(
  root: string,
  task: string,
  config: ContinuumConfig,
  opts: { mock: boolean; tui: boolean }
): Promise<void> {
  const store = new Store(root);
  const started = Date.now();
  const useTui = opts.tui && isTty();
  const adapters = buildAdapters(root, config, { real: !opts.mock });
  const providerViews = () => store.getProviders().map((p) => ({ id: p.id, state: p.state }));

  let dashboard: Dashboard | null = null;
  if (useTui) {
    dashboard = new Dashboard({
      project: config.project.name,
      mode: opts.mock ? "mock" : "live",
      onQuit: () => {
        // The operator aborted: free the writer lock and stop cleanly.
        try {
          fs.rmSync(path.join(root, ".continuum", "workspace.lock"), { force: true });
        } catch {
          /* nothing to release */
        }
        console.log("\nAborted. Writer lock released. Resume later with: continuum resume");
        process.exit(0);
      },
      onCheckpoint: () => {
        const cp = createCheckpoint(store, root, "manual");
        dashboard?.pushLog(`manual checkpoint #${cp.id} (${cp.filesChanged.length} files)`);
        dashboard?.paint(true);
      },
      onHandoff: () => {
        const file = path.join(store.handoffsDir, "latest.txt");
        dashboard?.pushLog(fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n")[0] : "(no handoff yet)");
        dashboard?.paint(true);
      },
    });
    dashboard.setProviders(providerViews());
    dashboard.start();
  }

  const dash = dashboard;
  const telemetry = dash
    ? {
        onLog: (line: string) => dash.pushLog(line),
        onSnapshot: (s: any) => {
          dash.update(s);
          dash.setProviders(providerViews());
        },
      }
    : { onLog: (line: string) => console.log(line) };

  try {
    const supervisor = new Supervisor(adapters, config, store, root, telemetry);
    const result = await supervisor.run(task);
    if (dash) {
      dash.setFinished();
      dash.paint(true);
      await dash.waitForDone(8000);
      dash.stop();
    }
    printResultSummary(store, result, Date.now() - started);
  } catch (err) {
    if (dash?.active) dash.stop();
    throw err;
  } finally {
    store.close();
  }
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
    console.log(`Next:`);
    console.log(`  continuum doctor        check which provider CLIs are installed & logged in`);
    console.log(`  continuum start         guided run — pick the starter, failover is automatic`);
    console.log(`  continuum run "<task>"  one-shot run without prompts`);
  });

program
  .command("doctor")
  .description("Check provider availability and login state")
  .option("--mock", "check mock providers instead of real CLIs")
  .action(async (opts) => {
    const [major, minor] = process.version.replace("v", "").split(".").map(Number);
    const nodeOk = major > 23 || (major === 23 && minor >= 4);
    console.log(`node ${process.version} (needs ${MIN_NODE})${nodeOk ? "" : "  <-- UPGRADE NODE"}`);
    const root = projectRoot();
    const config = loadConfig(root);
    const adapters = buildAdapters(root, config, { real: !opts.mock });
    if (adapters.size === 0) {
      console.log(
        opts.mock
          ? "No mock scripts found. Add providers to `.continuum/mock-providers.json` (see README) or run without --mock."
          : "No providers configured. Check `.continuum/config.yaml` routing order."
      );
      return;
    }
    for (const [id, adapter] of adapters) {
      const installed = await adapter.detect();
      if (!installed) {
        console.log(`${id.padEnd(14)} installed=no  auth=no (${loginHint(id)} to set up)`);
        continue;
      }
      const probe = await adapter.checkAuth?.() ?? null;
      if (probe === null) {
        console.log(`${id.padEnd(14)} installed=yes auth=? (verified automatically on first run)`);
      } else if (probe.ok) {
        console.log(`${id.padEnd(14)} installed=yes auth=yes (${probe.detail})`);
      } else {
        console.log(`${id.padEnd(14)} installed=yes auth=NO (${probe.detail}) -> run: ${loginHint(id)}`);
      }
    }
    console.log(`Next: continuum start (guided run) | continuum run "<task>"`);
  });

program
  .command("run")
  .description("Run a task through the provider chain")
  .argument("<task>", "task description")
  .option("--mock", "run against mock providers instead of real CLIs")
  .option("--no-tui", "plain log output instead of the live dashboard")
  .action(async (task: string, opts) => {
    try {
      await executeRun(projectRoot(), task, loadConfig(projectRoot()), { mock: Boolean(opts.mock), tui: opts.tui !== false });
    } catch (err: any) {
      console.error(err?.message ?? String(err));
      process.exitCode = 1;
    }
  });

program
  .command("status")
  .description("Show current task, providers and context state")
  .action(() => {
    const root = projectRoot();
    const store = new Store(root);
    const active = store.getActiveTask();
    if (active) {
      console.log(`Task: #${active.id} "${active.description}" (${active.status}, provider=${active.current_provider ?? "?"})`);
      if (active.status === "paused") console.log(`  -> resume with: continuum resume`);
    } else {
      const last = store.getLatestTask();
      console.log(
        last
          ? `Task: #${last.id} "${last.description}" (${last.status}, provider=${last.current_provider ?? "?"})`
          : `Task: (no tasks yet — run: continuum start)`
      );
    }
    for (const p of store.getProviders()) {
      console.log(`${p.id.padEnd(14)} ${p.state}${p.available_at ? ` (available at ${p.available_at})` : ""}`);
    }
    const events = store.readEvents();
    const cp = store.getLatestCheckpoint();
    const handoffs = fs.readdirSync(store.handoffsDir).filter((f) => f.endsWith(".txt") && f !== "latest.txt").length;
    console.log(`Events: ${events.length}  Checkpoints: ${cp ? `latest #${cp.id}` : "(none)"}  Handoffs: ${handoffs}`);
    if (!active) console.log(`Next: continuum start (new task) | continuum logs (history)`);
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
    console.log(`Next: continuum handoff (if you switch providers) | continuum logs`);
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
  .command("search")
  .description("Search durable memory and compacted task summaries")
  .argument("<query>", "search terms")
  .option("-n, --limit <n>", "max results", "8")
  .action((query: string, opts) => {
    const root = projectRoot();
    const store = new Store(root);
    const hits = semanticSearch(store, root, query, Number(opts.limit));
    if (hits.length === 0) console.log("(no matches)");
    for (const h of hits) console.log(`${h.source}: ${h.snippet}`);
    store.close();
  });

program
  .command("compact")
  .description("Compact the latest task's event history into durable memory")
  .action(() => {
    const root = projectRoot();
    const store = new Store(root);
    const task = store.getActiveTask() ?? store.getLatestTask();
    if (!task) {
      console.log("No task to compact yet. Run one with `continuum start`.");
      store.close();
      return;
    }
    const c = compactTask(store, task.id);
    console.log(`Task #${task.id}: compacted ${c.events} events (~${c.tokensBefore} → ~${c.tokensAfter} tokens).`);
    console.log(`Summary stored. Next: continuum search "<query>" | continuum handoff`);
    store.close();
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
  .option("--no-tui", "plain log output instead of the live dashboard")
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
    store.close();
    try {
      await executeRun(root, task.description, loadConfig(root), { mock: Boolean(opts.mock), tui: opts.tui !== false });
    } catch (err: any) {
      console.error(err?.message ?? String(err));
      process.exitCode = 1;
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
      if (adapters.size === 0) {
        console.log(
          opts.mock
            ? "No mock scripts found. Add providers to `.continuum/mock-providers.json` first (see README), or run `continuum start` without --mock."
            : "No providers available. Run `continuum doctor` to check installs."
        );
        return;
      }
      console.log("\n=== CONTINUUM ===  Agent can stop. Context doesn't.\n");
      console.log("Providers (checked now, no tokens spent on standby):");
      const rows: Array<{ id: string; ok: boolean }> = [];
      for (const id of config.routing.order) {
        const a = adapters.get(id);
        if (!a) {
          console.log(`  -. ${id.padEnd(12)} ${opts.mock ? "NO MOCK SCRIPT (skipped)" : "NOT CONFIGURED (skipped)"}`);
          continue;
        }
        const ok = await a.detect();
        rows.push({ id, ok });
        console.log(`  ${rows.length}. ${id.padEnd(12)} ${ok ? "READY" : "NOT INSTALLED (auto-skipped)"}`);
      }
      if (rows.length === 0) {
        console.log("Nothing to run with. Fix the list above, then try again.");
        return;
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
      await executeRun(root, task, config, { mock: Boolean(opts.mock), tui: true });
    } catch (err: any) {
      console.error(err?.message ?? String(err));
      process.exitCode = 1;
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
    console.log(`Next: continuum start (guided run) | continuum run "<task>"`);
  });

program
  .command("config")
  .description("View or change routing, models and retries without editing YAML")
  .option("--show", "print the current config and exit")
  .action(async (opts) => {
    const root = projectRoot();
    if (opts.show) {
      console.log(fs.readFileSync(path.join(root, ".continuum", "config.yaml"), "utf8"));
      return;
    }
    const { createInterface } = await import("node:readline/promises");
    const { stdin: input, stdout: output } = await import("node:process");
    const rl = createInterface({ input, output });
    try {
      const config = loadConfig(root);
      for (;;) {
        console.log(`\nOrder: ${config.routing.order.join(" -> ")}`);
        console.log(`Routing mode: ${config.routing.mode}`);
        console.log(`Retries (transient failures): ${config.failover.temporary_rate_limit.max_attempts}`);
        for (const [id, v] of Object.entries(config.providers ?? {})) {
          if (v?.model) console.log(`Model ${id}: ${v.model}`);
        }
        const choice = (await rl.question("\n1. Set starter provider  2. Set model  3. Set retries  4. Routing mode  5. Quit\n> ")).trim();
        if (choice === "1") {
          config.routing.order.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
          const n = parseInt((await rl.question("Start with? [number]\n> ")).trim(), 10);
          if (n >= 1 && n <= config.routing.order.length) {
            const first = config.routing.order[n - 1];
            config.routing.order = [first, ...config.routing.order.filter((p) => p !== first)];
          } else {
            console.log("Out of range, order unchanged.");
          }
        } else if (choice === "2") {
          const id = (await rl.question(`Provider id (${config.routing.order.join("/")})?\n> `)).trim();
          if (!config.routing.order.includes(id)) {
            console.log(`Unknown provider "${id}".`);
            continue;
          }
          const model = (await rl.question("Model (empty = CLI default, clears override)?\n> ")).trim();
          config.providers = { ...config.providers, [id]: model ? { model } : {} };
          console.log(model ? `Model for ${id}: ${model}` : `Model override for ${id} cleared.`);
        } else if (choice === "3") {
          const n = parseInt((await rl.question("Retry attempts for transient failures? [0-10]\n> ")).trim(), 10);
          if (Number.isInteger(n) && n >= 0 && n <= 10) {
            config.failover.temporary_rate_limit.max_attempts = n;
          } else {
            console.log("Out of range, unchanged.");
          }
        } else if (choice === "4") {
          const mode = (await rl.question("Routing mode — ordered (verbatim) or smart (health-aware)? [ordered/smart]\n> ")).trim();
          if (mode === "ordered" || mode === "smart") {
            config.routing.mode = mode;
          } else {
            console.log("Unchanged (expected: ordered or smart).");
          }
        } else {
          break;
        }
        writeConfig(root, config);
        console.log("Saved.");
      }
    } finally {
      rl.close();
    }
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
