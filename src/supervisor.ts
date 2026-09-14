import type { AgentAdapter } from "./adapters/types.js";
import type { ContinuumConfig } from "./config.js";
import { WorkspaceLock } from "./lock.js";
import { createCheckpoint } from "./checkpoint.js";
import { buildHandoffCapsule } from "./handoff.js";
import type { Store } from "./store.js";
import { ContinuumError, type NormalizedError } from "./types.js";

export interface SupervisorEvents {
  onLog?: (line: string) => void;
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * Deterministic core runtime. No LLM anywhere in the control path: it owns
 * routing, sessions, workspace locking, checkpoints, handoff and failover.
 */
export class Supervisor {
  constructor(
    private readonly adapters: Map<string, AgentAdapter>,
    private readonly config: ContinuumConfig,
    private readonly store: Store,
    private readonly cwd: string,
    private readonly events: SupervisorEvents = {}
  ) {}

  private log(line: string) {
    this.events.onLog?.(line);
  }

  /** Runs the task through the configured provider order, failing over on
   *  quota exhaustion / provider unavailability with checkpoint + handoff. */
  async run(task: string): Promise<{ taskId: number; providerId: string; status: "completed" | "exhausted" }> {
    const taskId = this.store.createTask(task);
    const order = this.config.routing.order.filter((id) => this.adapters.has(id));
    if (order.length === 0) {
      throw new Error(
        "No providers available for routing. " +
          (this.adapters.size === 0
            ? "No adapters were built: install a provider CLI then run `continuum doctor`, or for an offline demo add scripts to `.continuum/mock-providers.json` and use `--mock`."
            : `Configured [${this.config.routing.order.join(", ")}] but none are registered. Run \`continuum doctor\` to check installs.`)
      );
    }
    const runStart = Date.now();

    let handoff: string | undefined;
    let lastReason: NormalizedError | undefined;
    let index = 0;
    const attempts = new Map<string, number>();

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
      let lastTick = providerStart;
      let filesTouched = 0;
      let commandsRun = 0;

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
          if (event.type === "FileChanged") filesTouched++;
          if (event.type === "CommandExecuted") commandsRun++;
          if (event.type === "TextDelta") this.log(event.text.replace(/\n$/, ""));
          // Heartbeat for long runs so the terminal never looks dead.
          if (Date.now() - lastTick > 30000) {
            lastTick = Date.now();
            this.log(`... still working on ${providerId} (${fmtElapsed(lastTick - providerStart)}, ${filesTouched} files, ${commandsRun} commands)`);
          }
        }

        // Completed cleanly.
        if (this.config.context.auto_checkpoint) {
          const cp = createCheckpoint(this.store, this.cwd, providerId);
          this.store.appendEvent(taskId, { type: "CheckpointCreated", checkpointId: String(cp.id), at: new Date().toISOString() });
        }
        this.store.setProviderState(providerId, "READY");
        if (this.config.workspace.writer_lock) lock.release(providerId);
        this.store.updateTask(taskId, { status: "completed", finishedAt: new Date().toISOString() });
        this.log(`Task completed by ${providerId} in ${fmtElapsed(Date.now() - providerStart)} (${filesTouched} files, ${commandsRun} commands, ${fmtElapsed(Date.now() - runStart)} total).`);
        return { taskId, providerId, status: "completed" };
      } catch (err) {
        const { code, message } = adapter.normalizeError(err);
        this.store.appendEvent(taskId, { type: "AgentError", error: code, message, at: new Date().toISOString() });
        this.log(`${providerId} failed: [${code}] ${message}`);
        await adapter.interrupt();

        switch (code) {
          case "QUOTA_EXHAUSTED":
          case "PROVIDER_UNAVAILABLE": {
            if (code === "QUOTA_EXHAUSTED" && !this.config.failover.quota_exhausted) {
              this.store.setProviderState(providerId, "EXHAUSTED");
              if (this.config.workspace.writer_lock) lock.release(providerId);
              this.store.updateTask(taskId, { status: "paused" });
              return { taskId, providerId, status: "exhausted" };
            }
            // Leaving this provider: freeze → checkpoint → capsule → unlock.
            const checkpoint = createCheckpoint(this.store, this.cwd, providerId);
            this.store.appendEvent(taskId, { type: "CheckpointCreated", checkpointId: String(checkpoint.id), at: new Date().toISOString() });
            if (this.config.workspace.writer_lock) lock.release(providerId);
            this.store.setProviderState(
              providerId,
              code === "QUOTA_EXHAUSTED" ? "EXHAUSTED" : "UNAVAILABLE",
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
            });
            const hid = this.store.nextHandoffId();
            this.store.saveHandoff(hid, handoff);
            this.log(`Handoff capsule #${hid} created. Transferring to next provider...`);
            lastReason = code;
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
            this.log("Authentication required. Paused; run authentication then `continuum resume`.");
            return { taskId, providerId, status: "exhausted" };
          }
          default: {
            this.store.setProviderState(providerId, "FAILED");
            if (this.config.workspace.writer_lock) lock.release(providerId);
            this.store.updateTask(taskId, { status: "paused" });
            throw err instanceof ContinuumError ? err : new ContinuumError("AGENT_CRASH", message);
          }
        }
      }
    }

    this.store.updateTask(taskId, { status: "paused" });
    this.log(`All providers exhausted (last reason: ${lastReason}).`);
    return { taskId, providerId: order[order.length - 1], status: "exhausted" };
  }
}
