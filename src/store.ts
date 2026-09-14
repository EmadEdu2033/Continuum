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
  private ftsEnabled = false;

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
      CREATE TABLE IF NOT EXISTS summaries (
        task_id INTEGER PRIMARY KEY,
        text TEXT NOT NULL,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS provider_failures (
        id TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        last_at TEXT
      );
    `);
    // FTS5 makes retrieval ranked and cheap; fall back to LIKE if unavailable.
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(source UNINDEXED, content);`);
      this.ftsEnabled = true;
    } catch {
      this.ftsEnabled = false;
      this.db.exec(`CREATE TABLE IF NOT EXISTS memory_docs (source TEXT, content TEXT);`);
    }
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

  /** Most recent task of any status — for `status` after a task finished. */
  getLatestTask(): any {
    return this.db.prepare(`SELECT * FROM tasks ORDER BY id DESC LIMIT 1`).get();
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

  // ── Context compaction ────────────────────────────────────────────────
  saveSummary(taskId: number, text: string) {
    this.db
      .prepare(
        `INSERT INTO summaries (task_id, text, created_at) VALUES (?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`
      )
      .run(taskId, text, new Date().toISOString());
  }

  getSummary(taskId: number): string | null {
    const row = this.db.prepare(`SELECT text FROM summaries WHERE task_id = ?`).get(taskId) as { text?: string } | undefined;
    return row?.text ?? null;
  }

  getAllSummaries(): Array<{ task_id: number; text: string }> {
    return this.db.prepare(`SELECT task_id, text FROM summaries ORDER BY task_id`).all() as any;
  }

  // ── Smart routing signal ──────────────────────────────────────────────
  recordFailure(providerId: string) {
    this.db
      .prepare(
        `INSERT INTO provider_failures (id, count, last_at) VALUES (?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET count = count + 1, last_at = excluded.last_at`
      )
      .run(providerId, new Date().toISOString());
  }

  resetFailures(providerId: string) {
    this.db.prepare(`UPDATE provider_failures SET count = 0 WHERE id = ?`).run(providerId);
  }

  getFailureCounts(): Map<string, number> {
    const rows = this.db.prepare(`SELECT id, count FROM provider_failures`).all() as Array<{ id: string; count: number }>;
    return new Map(rows.map((r) => [r.id, r.count]));
  }

  // ── Optional semantic retrieval (FTS5 BM25; LIKE fallback) ────────────
  reindexMemory(docs: Array<{ source: string; content: string }>) {
    const table = this.ftsEnabled ? "memory_fts" : "memory_docs";
    this.db.exec(`DELETE FROM ${table}`);
    const stmt = this.db.prepare(`INSERT INTO ${table} (source, content) VALUES (?, ?)`);
    for (const d of docs) stmt.run(d.source, d.content);
  }

  searchMemory(query: string, limit = 8): Array<{ source: string; snippet: string }> {
    if (this.ftsEnabled) {
      const terms = query.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, "")}"`);
      if (terms.length === 0) return [];
      try {
        const rows = this.db
          .prepare(
            `SELECT source, snippet(memory_fts, 1, '«', '»', '…', 10) AS snip
             FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?`
          )
          .all(terms.join(" OR "), limit) as Array<{ source: string; snip: string }>;
        return rows.map((r) => ({ source: r.source, snippet: r.snip }));
      } catch {
        /* fall through to LIKE */
      }
    }
    const rows = this.db
      .prepare(`SELECT source, content FROM memory_docs WHERE content LIKE ? LIMIT ?`)
      .all(`%${query}%`, limit) as Array<{ source: string; content: string }>;
    return rows.map((r) => ({ source: r.source, snippet: r.content.slice(0, 200) }));
  }

  get fts(): boolean {
    return this.ftsEnabled;
  }

  close() {
    this.db.close();
  }
}
