import type { ProviderView, SupervisorSnapshot } from "../telemetry.js";
import { renderFrame } from "./render.js";
import { enterAltScreen, exitAltScreen, hideCursor, showCursor, startInput, onResize, size, resetStyle, draw, isTty, write } from "./term.js";

export interface DashboardOptions {
  project: string;
  mode: string;
  onQuit?: () => void;
  onSwitch?: (provider: string) => void;
  onCheckpoint?: () => void;
  onHandoff?: () => void;
}

const IDLE_SNAPSHOT = (project: string): SupervisorSnapshot => ({
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
  message: project,
});

/**
 * Live terminal dashboard. Renders a frame every ~110ms and repaints only when
 * something changed (or the spinner ticked), so it stays cheap during long runs.
 */
export class Dashboard {
  private snapshot: SupervisorSnapshot;
  private logs: string[] = [];
  private providers: ProviderView[] = [];
  private spinner = 0;
  private timer: NodeJS.Timeout | null = null;
  private restoreInput: (() => void) | null = null;
  private restoreResize: (() => void) | null = null;
  private running = false;
  private finished = false;
  private lastFrame = "";
  private doneResolver: (() => void) | null = null;

  constructor(private readonly opts: DashboardOptions) {
    this.snapshot = IDLE_SNAPSHOT(opts.project);
  }

  get active(): boolean {
    return this.running;
  }

  get isDone(): boolean {
    return this.finished;
  }

  update(snapshot: SupervisorSnapshot): void {
    this.snapshot = { ...this.snapshot, ...snapshot };
  }

  setProviders(providers: ProviderView[]): void {
    this.providers = providers;
  }

  pushLog(line: string): void {
    for (const l of line.split("\n")) {
      if (l.trim()) this.logs.push(l);
    }
    if (this.logs.length > 400) this.logs = this.logs.slice(-400);
  }

  setFinished(): void {
    this.finished = true;
  }

  /** Resolves when the user presses a key after the run finished (or timeout). */
  waitForDone(timeoutMs = 0): Promise<void> {
    return new Promise((resolve) => {
      this.doneResolver = resolve;
      if (timeoutMs > 0) setTimeout(() => this.resolveDone(), timeoutMs);
    });
  }

  private resolveDone(): void {
    const r = this.doneResolver;
    this.doneResolver = null;
    r?.();
  }

  start(): void {
    if (!isTty()) return;
    this.running = true;
    enterAltScreen();
    hideCursor();
    this.restoreInput = startInput((key) => {
      // Once the run is over, any key dismisses the dashboard.
      if (this.finished) {
        this.resolveDone();
        return;
      }
      if (key.name === "q" || key.ctrl || key.name === "escape") {
        this.stop();
        this.opts.onQuit?.();
        return;
      }
      if (key.name === "c") this.opts.onCheckpoint?.();
      else if (key.name === "h") this.opts.onHandoff?.();
      else if (key.name === "s") this.opts.onSwitch?.("");
    });
    this.restoreResize = onResize(() => this.paint(true));
    this.timer = setInterval(() => {
      this.spinner++;
      this.paint(false);
    }, 110);
    this.paint(true);
  }

  /** Repaint now (e.g. after a log line) with change detection. */
  paint(force = false): void {
    if (!this.running) return;
    const frame = renderFrame({
      snapshot: this.snapshot,
      providers: this.providers,
      logs: this.logs,
      size: size(),
      spinner: this.spinner,
      project: this.opts.project,
      mode: this.opts.mode,
      finished: this.finished && this.snapshot.status !== "running",
    });
    if (force || frame !== this.lastFrame) {
      draw(frame);
      this.lastFrame = frame;
    }
  }

  /** Stops the dashboard and restores the terminal. Safe to call twice. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.restoreInput?.();
    this.restoreResize?.();
    showCursor();
    resetStyle();
    exitAltScreen();
    this.flushFinal();
  }

  /** After leaving the alternate screen, replay the important lines inline. */
  private flushFinal(): void {
    const tail = this.logs.slice(-8);
    for (const l of tail) write(`${l}\n`);
  }
}
