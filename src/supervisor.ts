import type { AgentAdapter } from "./adapters/types.js";
import type { ContinuumConfig } from "./config.js";
import { WorkspaceLock } from "./lock.js";
import { createCheckpoint } from "./checkpoint.js";
import { buildHandoffCapsule } from "./handoff.js";
import { compactTask } from "./compactor.js";
import { planRoute } from "./routing.js";
import type { Store } from "./store.js";
import { ContinuumError, type NormalizedError } from "./types.js";
import type { SupervisorSnapshot, Telemetry } from "./telemetry.js";

export type { Telemetry, SupervisorSnapshot } from "./telemetry.js";

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export interface RunResult {
  taskId: number;
  providerId: string;
  status: "completed" | "exhausted";
}

/**
 * Deterministic core runtime. No LLM in the control path: it owns routing,
 * sessions, workspace locking, checkpoints, compaction, handoff and failover.
 */
export class Supervisor {
  private snapshot: SupervisorSnapshot;
  private handoffCount = 0;

  constructor(
    private readonly adapters: Map<string, AgentAdapter>,
    private readonly config: ContinuumConfig,
    private readonly store: Store,
    private readonly cwd: string,
    private readonly telemetry: Telemetry = {}
  ) {
    this.snapshot = {
      task: "",
      taskId: 0,
      order: [],
      index: 0,
      providerId: null,
      status: "idle",
      filesTouched: 0,
      commandsRun: 0,
      startedAt: Date.now(),
      activeSince: null,
      lastError: null,
      checkpointId: null,
      handoffCount: 0,
      message: "",
    };
  }

  private log(line: string) {
    this.telemetry.onLog?.(line);
  }

  private emit(patch: Partial<SupervisorSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.telemetry.onSnapshot?.(this.snapshot);
  }

  private planOrder(): string[] {
    const available = new Set(this.adapters.keys());
    const states = new Map(this.store.getProviders().map((p) => [p.id, p.state]));
    return planRoute({
      configured: this.config.routing.order,
      available,
      states,
      failures: this.store.getFailureCounts(),
      mode: this.config.routing.mode,
    }).map((d) => d.id);
  }

  /** Runs the task through the provider order, failing over on quota, provider
   *  unavailability or context exhaustion with checkpoint + handoff. */
  async run(task: string): Promise<RunResult> {
    // Resolve the route before creating a task row: a run that cannot start
    // must not leave a phantom "active" task behind for `resume` to pick up.
    const order = this.planOrder();
    if (order.length === 0) {
      throw new Error(
        "No providers available for routing. " +
          (this.adapters.size === 0
            ? "No adapters were built: install a provider CLI then run `continuum doctor`, or for an offline demo add scripts to `.continuum/mock-providers.json` and use `--mock`."
            : `Configured [${this.config.routing.order.join(", ")}] but none are registered. Run \`continuum doctor\` to check installs.`)
      );
    }
    const taskId = this.store.createTask(task);
    const runStart = Date.now();
    this.emit({ task, taskId, order, index: 0, status: "running", startedAt: runStart, providerId: null, lastError: null, handoffCount: 0, message: "" });

    let handoff: string | undefined;
    let lastReason: NormalizedError | undefined;
    let index = 0;
    const attempts = new Map<string, number>();
    const filesByProvider = new Map<string, number>();
    const commandsByProvider = new Map<string, number>();

    while (index < order.length) {
      const providerId = order[index];
      const adapter = this.adapters.get(providerId)!;
      const lock = new WorkspaceLock(this.cwd);

      // Pre-flight: an uninstalled provider never held the lock, so skip it
      // without a checkpoint/handoff cycle.
      const health = await adapter.health();
      if (!health.installed) {
        this.store.setProviderState(providerId, "UNAVAILABLE");
        this.log(`${providerId} is not installed; skipping.`);
        index++;
        continue;
      }

      this.store.setProviderState(providerId, "ACTIVE", { sessionId: null });
      this.store.updateTask(taskId, { currentProvider: providerId });
      if (this.config.workspace.writer_lock) lock.acquire(providerId);
      this.log(`${providerId} is now the active writer (${index + 1}/${order.length}).`);
      const providerStart = Date.now();
      this.emit({ providerId, index, activeSince: providerStart, filesTouched: filesByProvider.get(providerId) ?? 0, commandsRun: commandsByProvider.get(providerId) ?? 0 });

      let lastTick = providerStart;
      let filesTouched = filesByProvider.get(providerId) ?? 0;
      let commandsRun = commandsByProvider.get(providerId) ?? 0;

      try {
        // Continue the provider's native session only when it belongs to THIS
        // task (retries, returns after failover). A session saved for an older
        // task would inject stale context, so those start fresh.
        const saved = this.store.getSession(providerId);
        const input = { task, handoff, cwd: this.cwd };
        const stream =
          saved?.sessionId && saved.task === task
            ? adapter.resume(saved.sessionId, input)
            : adapter.start(input);
        for await (const event of stream) {
          this.store.appendEvent(taskId, event);
          if (event.type === "SessionStarted") {
            this.store.setProviderState(providerId, "ACTIVE", { sessionId: event.sessionId });
            this.store.saveSession(providerId, { sessionId: event.sessionId, task });
          }
          if (event.type === "FileChanged") {
            filesTouched++;
            this.emit({ filesTouched });
          }
          if (event.type === "CommandExecuted") {
            commandsRun++;
            this.emit({ commandsRun });
          }
          if (event.type === "TextDelta") this.log(event.text.replace(/\n$/, ""));
          // Heartbeat for long runs so the terminal never looks dead.
          if (Date.now() - lastTick > 30000) {
            lastTick = Date.now();
            this.log(`... still working on ${providerId} (${fmtElapsed(lastTick - providerStart)}, ${filesTouched} files, ${commandsRun} commands)`);
          }
        }
        filesByProvider.set(providerId, filesTouched);
        commandsByProvider.set(providerId, commandsRun);

        // Completed cleanly.
        let checkpointId: string | null = this.snapshot.checkpointId;
        if (this.config.context.auto_checkpoint) {
          const cp = createCheckpoint(this.store, this.cwd, providerId);
          checkpointId = String(cp.id);
          this.store.appendEvent(taskId, { type: "CheckpointCreated", checkpointId, at: new Date().toISOString() });
        }
        this.store.setProviderState(providerId, "READY");
        this.store.resetFailures(providerId);
        if (this.config.workspace.writer_lock) lock.release(providerId);
        this.store.updateTask(taskId, { status: "completed", finishedAt: new Date().toISOString() });
        this.emit({ status: "completed", checkpointId, activeSince: null, providerId });
        this.log(`Task completed by ${providerId} in ${fmtElapsed(Date.now() - providerStart)} (${filesTouched} files, ${commandsRun} commands, ${fmtElapsed(Date.now() - runStart)} total).`);
        return { taskId, providerId, status: "completed" };
      } catch (err) {
        const { code, message } = adapter.normalizeError(err);
        this.store.appendEvent(taskId, { type: "AgentError", error: code, message, at: new Date().toISOString() });
        this.store.recordFailure(providerId);
        this.log(`${providerId} failed: [${code}] ${message}`);
        this.emit({ lastError: { code, message }, activeSince: null });
        await adapter.interrupt();

        switch (code) {
          case "QUOTA_EXHAUSTED":
          case "PROVIDER_UNAVAILABLE":
          case "CONTEXT_EXHAUSTED": {
            if (code === "QUOTA_EXHAUSTED" && !this.config.failover.quota_exhausted) {
              this.store.setProviderState(providerId, "EXHAUSTED");
              if (this.config.workspace.writer_lock) lock.release(providerId);
              this.store.updateTask(taskId, { status: "paused" });
              this.emit({ status: "paused" });
              return { taskId, providerId, status: "exhausted" };
            }
            // Leaving this provider: freeze → checkpoint → compact → capsule → unlock.
            const checkpoint = createCheckpoint(this.store, this.cwd, providerId);
            this.store.appendEvent(taskId, { type: "CheckpointCreated", checkpointId: String(checkpoint.id), at: new Date().toISOString() });
            const compacted = compactTask(this.store, taskId, Math.min(this.config.context.max_handoff_tokens, 1500));
            if (code === "CONTEXT_EXHAUSTED") {
              this.log(`Context exhausted on ${providerId}; compacted ${compacted.events} events (~${compacted.tokensBefore}→~${compacted.tokensAfter} tokens).`);
            }
            if (this.config.workspace.writer_lock) lock.release(providerId);
            this.store.setProviderState(
              providerId,
              code === "QUOTA_EXHAUSTED" ? "EXHAUSTED" : code === "CONTEXT_EXHAUSTED" ? "COOLDOWN" : "UNAVAILABLE",
              { availableAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString() }
            );
            this.log(`Checkpoint #${checkpoint.id} created.`);
            handoff = buildHandoffCapsule({
              store: this.store,
              cwd: this.cwd,
              projectId: this.config.project.name,
              task,
              taskId,
              fromProvider: providerId,
              reason: code,
              checkpoint,
              maxTokens: this.config.context.max_handoff_tokens,
              summary: compacted.text,
            });
            const hid = this.store.nextHandoffId();
            this.store.saveHandoff(hid, handoff);
            this.handoffCount++;
            lastReason = code;
            this.emit({ checkpointId: String(checkpoint.id), handoffCount: this.handoffCount });
            this.log(`Handoff capsule #${hid} created. Transferring to next provider...`);
            index++;
            continue;
          }
          case "TEMP_RATE_LIMIT":
          case "NETWORK_FAILURE": {
            const { retry, max_attempts } = this.config.failover.temporary_rate_limit;
            const tried = (attempts.get(providerId) ?? 0) + 1;
            attempts.set(providerId, tried);
            if (retry && tried <= max_attempts) {
              // Same provider keeps the writer lock; exponential-ish backoff.
              this.store.setProviderState(providerId, "COOLDOWN");
              const backoffMs = 2000 * tried;
              this.log(`Transient failure; retrying ${providerId} in ${backoffMs / 1000}s (attempt ${tried}/${max_attempts}).`);
              await new Promise((r) => setTimeout(r, backoffMs));
              this.store.setProviderState(providerId, "ACTIVE");
              continue;
            }
            this.log(`${providerId} exhausted retry attempts; moving on.`);
            this.store.setProviderState(providerId, "COOLDOWN");
            if (this.config.workspace.writer_lock) lock.release(providerId);
            lastReason = code;
            index++;
            continue;
          }
          case "AUTH_REQUIRED": {
            this.store.setProviderState(providerId, "AUTH_REQUIRED");
            if (this.config.workspace.writer_lock) lock.release(providerId);
            this.store.updateTask(taskId, { status: "paused" });
            this.emit({ status: "paused" });
            this.log("Authentication required. Paused; run authentication then `continuum resume`.");
            return { taskId, providerId, status: "exhausted" };
          }
          default: {
            this.store.setProviderState(providerId, "FAILED");
            if (this.config.workspace.writer_lock) lock.release(providerId);
            this.store.updateTask(taskId, { status: "paused" });
            this.emit({ status: "paused" });
            throw err instanceof ContinuumError ? err : new ContinuumError("AGENT_CRASH", message);
          }
        }
      }
    }

    this.store.updateTask(taskId, { status: "paused" });
    this.emit({ status: "exhausted", activeSince: null });
    this.log(`All providers exhausted (last reason: ${lastReason}).`);
    return { taskId, providerId: order[order.length - 1], status: "exhausted" };
  }
}
