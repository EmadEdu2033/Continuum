import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Workspace writer lock: only one coding agent may own write access to the
 * primary working tree at a time.
 */
export class WorkspaceLock {
  private readonly lockPath: string;
  private currentHolder: string | null = null;

  constructor(projectRoot: string) {
    this.lockPath = path.join(projectRoot, ".continuum", "workspace.lock");
  }

  holder(): string | null {
    if (this.currentHolder) return this.currentHolder;
    try {
      return fs.readFileSync(this.lockPath, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  acquire(providerId: string): void {
    const existing = this.holder();
    if (existing && existing !== providerId) {
      throw new Error(
        `workspace.lock is held by "${existing}"; cannot grant write access to "${providerId}"`
      );
    }
    this.currentHolder = providerId;
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    fs.writeFileSync(this.lockPath, providerId, "utf8");
  }

  release(providerId: string): void {
    if (this.holder() === providerId) {
      this.currentHolder = null;
      fs.rmSync(this.lockPath, { force: true });
    }
  }
}
