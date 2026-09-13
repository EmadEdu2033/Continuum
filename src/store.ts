import { DatabaseSync } from "./sqlite.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentEvent } from "./types.js";

/**
 * Durable state store under `.continuum/`. SQLite for structured state,
 * NDJSON append-only event log for everything the agents emit.
 */
export class Store {
  readonly root: string;
  readonly eventsPath: string;
  readonly handoffsDir: string;
  readonly checkpointsDir: string;
  readonly sessionsDir: string;
  private db: InstanceType<typeof DatabaseSync>;

  constructor(projectRoot: string) {
    this.root = path.join(projectRoot, ".continuum");
    this.eventsPath = path.join(this.root, "events.ndjson");
    this.handoffsDir = path.join(this.root, "handoffs");
    this.checkpointsDir = path.join(this.root, "checkpoints");
    this.sessionsDir = path.join(this.root, "sessions");
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(this.handoffsDir, { recursive: true });
    fs.mkdirSync(this.checkpointsDir, { recursive: true });
    fs.mkdirSync(this.sessionsDir, { recursive: true });

    this.db = new DatabaseSync(path.join(this.root, "state.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'READY',
        session_id TEXT,
        available_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        current_provider TEXT,
        created_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        git_status TEXT,
        git_diff TEXT,
        files_changed TEXT,
        created_at TEXT
      );
    `);
  }

  setProviderState(id: string, state: string, extra?: { sessionId?: string | null; availableAt?: string | null }) {
    this.db
      .prepare(
        `INSERT INTO providers (id, state, session_id, available_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           session_id = COALESCE(excluded.session_id, providers.session_id),
           available_at = excluded.available_at,
           updated_at = excluded.updated_at`
      )
      .run(id, state, extra?.sessionId ?? null, extra?.availableAt ?? null, new Date().toISOString());
  }

  getProviders(): Array<{ id: string; state: string; session_id: string | null; available_at: string | null }> {
    return this.db
      .prepare(`SELECT id, state, session_id, available_at FROM providers ORDER BY rowid`)
      .all() as any;
  }

  createTask(description: string): number {
    const res = this.db
      .prepare(`INSERT INTO tasks (description, status, created_at) VALUES (?, 'active', ?)`)
      .run(description, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  updateTask(id: number, patch: { status?: string; currentProvider?: string | null; finishedAt?: string }) {
    const task = this.getTask(id);
    if (!task) return;
    this.db
      .prepare(`UPDATE tasks SET status = ?, current_provider = ?, finished_at = ? WHERE id = ?`)
      .run(
        patch.status ?? task.status,
        patch.currentProvider ?? task.current_provider,
        patch.finishedAt ?? task.finished_at,
        id
      );
  }

  getTask(id: number): any {
    return this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  }

  /** Latest task that is still open (active or paused and resumable). */
  getActiveTask(): any {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE status IN ('active', 'paused') ORDER BY id DESC LIMIT 1`)
      .get();
  }

  saveCheckpoint(providerId: string, gitStatus: string, gitDiff: string, filesChanged: string[]): number {
    const res = this.db
      .prepare(
        `INSERT INTO checkpoints (provider_id, git_status, git_diff, files_changed, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(providerId, gitStatus, gitDiff, JSON.stringify(filesChanged), new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  getLatestCheckpoint(): any {
    return this.db.prepare(`SELECT * FROM checkpoints ORDER BY id DESC LIMIT 1`).get();
  }

  appendEvent(taskId: number | null, event: AgentEvent) {
    fs.appendFileSync(
      this.eventsPath,
      JSON.stringify({ ts: new Date().toISOString(), taskId, ...event }) + "\n",
      "utf8"
    );
  }

  readEvents(): Array<AgentEvent & { ts: string; taskId: number | null }> {
    if (!fs.existsSync(this.eventsPath)) return [];
    return fs
      .readFileSync(this.eventsPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }

  saveHandoff(id: number, capsule: string) {
    fs.writeFileSync(path.join(this.handoffsDir, `${String(id).padStart(4, "0")}.txt`), capsule, "utf8");
    fs.writeFileSync(path.join(this.handoffsDir, "latest.txt"), capsule, "utf8");
  }

  nextHandoffId(): number {
    return fs.readdirSync(this.handoffsDir).filter((f) => f.endsWith(".txt") && f !== "latest.txt").length + 1;
  }

  saveSession(providerId: string, data: unknown) {
    fs.writeFileSync(
      path.join(this.sessionsDir, `${providerId}.json`),
      JSON.stringify(data, null, 2),
      "utf8"
    );
  }

  getSession(providerId: string): { sessionId?: string; task?: string } | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.sessionsDir, `${providerId}.json`), "utf8"));
    } catch {
      return null;
    }
  }

  close() {
    this.db.close();
  }
}
