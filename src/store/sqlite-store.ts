// SQLite-based JobStore implementation using bun:sqlite with WAL mode.

import { Database } from "bun:sqlite";
import { config } from "../config.ts";
import { ensureDirSync } from "../fs-utils.ts";
import type { Job } from "../jobs.ts";
import type { JobStore } from "./job-store.ts";

const SCHEMA_VERSION = 2;

const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  sandbox TEXT NOT NULL,
  parent_session_id TEXT,
  cwd TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  tmux_session TEXT,
  pid INTEGER,
  exit_code INTEGER,
  runner TEXT NOT NULL DEFAULT 'tmux',
  result_preview TEXT,
  error TEXT,
  interactive INTEGER NOT NULL DEFAULT 0,
  keep_alive INTEGER NOT NULL DEFAULT 0,
  idle_detected_at TEXT,
  exit_sent INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  last_turn_completed_at TEXT,
  last_agent_message TEXT,
  turn_state TEXT,
  enrichment_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

type JobRow = {
  id: string;
  status: string;
  prompt: string;
  model: string;
  reasoning_effort: string;
  sandbox: string;
  parent_session_id: string | null;
  cwd: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  tmux_session: string | null;
  pid: number | null;
  exit_code: number | null;
  runner: string;
  result_preview: string | null;
  error: string | null;
  interactive: number;
  keep_alive: number;
  idle_detected_at: string | null;
  exit_sent: number;
  turn_count: number;
  last_turn_completed_at: string | null;
  last_agent_message: string | null;
  turn_state: string | null;
  enrichment_json: string | null;
  updated_at: string;
};

function jobToRow(job: Job): JobRow {
  return {
    id: job.id,
    status: job.status,
    prompt: job.prompt,
    model: job.model,
    reasoning_effort: job.reasoningEffort,
    sandbox: job.sandbox,
    parent_session_id: job.parentSessionId ?? null,
    cwd: job.cwd,
    created_at: job.createdAt,
    started_at: job.startedAt ?? null,
    completed_at: job.completedAt ?? null,
    tmux_session: job.tmuxSession ?? null,
    pid: job.pid ?? null,
    exit_code: job.exitCode ?? null,
    runner: job.runner ?? "tmux",
    result_preview: job.resultPreview ?? null,
    error: job.error ?? null,
    interactive: job.interactive ? 1 : 0,
    keep_alive: job.keepAlive ? 1 : 0,
    idle_detected_at: job.idleDetectedAt ?? null,
    exit_sent: job.exitSent ? 1 : 0,
    turn_count: job.turnCount ?? 0,
    last_turn_completed_at: job.lastTurnCompletedAt ?? null,
    last_agent_message: job.lastAgentMessage ?? null,
    turn_state: job.turnState ?? null,
    enrichment_json: job.enrichment ? JSON.stringify(job.enrichment) : null,
    updated_at: new Date().toISOString(),
  };
}

function rowToJob(row: JobRow): Job {
  let enrichment: Job["enrichment"] = undefined;
  if (row.enrichment_json) {
    try {
      enrichment = JSON.parse(row.enrichment_json);
    } catch {
      // Corrupt enrichment data — skip
    }
  }

  return {
    id: row.id,
    status: row.status as Job["status"],
    prompt: row.prompt,
    model: row.model,
    reasoningEffort: row.reasoning_effort as Job["reasoningEffort"],
    sandbox: row.sandbox as Job["sandbox"],
    parentSessionId: row.parent_session_id ?? undefined,
    cwd: row.cwd,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    tmuxSession: row.tmux_session ?? undefined,
    pid: row.pid ?? undefined,
    exitCode: row.exit_code ?? undefined,
    runner: (row.runner as Job["runner"]) ?? undefined,
    resultPreview: row.result_preview ?? undefined,
    error: row.error ?? undefined,
    interactive: row.interactive === 1,
    keepAlive: row.keep_alive === 1,
    idleDetectedAt: row.idle_detected_at ?? undefined,
    exitSent: row.exit_sent === 1,
    turnCount: row.turn_count || undefined,
    lastTurnCompletedAt: row.last_turn_completed_at ?? undefined,
    lastAgentMessage: row.last_agent_message ?? undefined,
    turnState: (row.turn_state as Job["turnState"]) ?? undefined,
    enrichment,
  };
}

export class SqliteStore implements JobStore {
  private db: Database;

  constructor(dbPath: string = config.sqliteDbPath) {
    ensureDirSync(config.jobsDir); // Ensure parent dir exists
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.bootstrap();
  }

  private bootstrap(): void {
    this.db.exec(CREATE_TABLES);

    // Check schema version
    const row = this.db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number | null } | null;
    const currentVersion = row?.v ?? 0;

    if (currentVersion < SCHEMA_VERSION) {
      this.migrate(currentVersion);
      this.db.prepare("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)").run(
        SCHEMA_VERSION,
        new Date().toISOString()
      );
    }
  }

  private migrate(fromVersion: number): void {
    if (fromVersion < 2) {
      // v2: add pid, exit_code, runner columns for spawn-based exec runner
      const cols = this.db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
      const existing = new Set(cols.map((c) => c.name));
      if (!existing.has("pid")) this.db.exec("ALTER TABLE jobs ADD COLUMN pid INTEGER");
      if (!existing.has("exit_code")) this.db.exec("ALTER TABLE jobs ADD COLUMN exit_code INTEGER");
      if (!existing.has("runner")) this.db.exec("ALTER TABLE jobs ADD COLUMN runner TEXT NOT NULL DEFAULT 'tmux'");
    }
  }

  /** Build $-prefixed params object from a JobRow for binding. */
  private static toParams(row: JobRow): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      params[`$${k}`] = v;
    }
    return params;
  }

  /** Column names and placeholders derived from JobRow keys. */
  private static get columns(): string[] {
    // Must match JobRow field order — kept in sync manually via type.
    return [
      "id", "status", "prompt", "model", "reasoning_effort", "sandbox",
      "parent_session_id", "cwd", "created_at", "started_at", "completed_at",
      "tmux_session", "pid", "exit_code", "runner",
      "result_preview", "error", "interactive", "keep_alive",
      "idle_detected_at", "exit_sent", "turn_count", "last_turn_completed_at",
      "last_agent_message", "turn_state", "enrichment_json", "updated_at",
    ];
  }

  private static insertSql(mode: "REPLACE" | "IGNORE"): string {
    const cols = SqliteStore.columns;
    const placeholders = cols.map((c) => `$${c}`).join(", ");
    return `INSERT OR ${mode} INTO jobs (${cols.join(", ")}) VALUES (${placeholders})`;
  }

  save(job: Job): void {
    const row = jobToRow(job);
    this.db.prepare(SqliteStore.insertSql("REPLACE")).run(SqliteStore.toParams(row));
  }

  load(jobId: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | null;
    if (!row) return null;
    return rowToJob(row);
  }

  list(): Job[] {
    const rows = this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() as JobRow[];
    return rows.map(rowToJob);
  }

  remove(jobId: string): boolean {
    const result = this.db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
    return result.changes > 0;
  }

  /** Bulk import jobs (for migration from JSON). Skips existing IDs. */
  importJobs(jobs: Job[]): number {
    let imported = 0;
    const insert = this.db.prepare(SqliteStore.insertSql("IGNORE"));

    const tx = this.db.transaction(() => {
      for (const job of jobs) {
        const row = jobToRow(job);
        const result = insert.run(SqliteStore.toParams(row));
        if (result.changes > 0) imported++;
      }
    });
    tx();

    return imported;
  }

  /** Count total jobs in SQLite. */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM jobs").get() as { c: number };
    return row.c;
  }

  close(): void {
    this.db.close();
  }
}
