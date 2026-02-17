// DualStore — writes to both JSON and SQLite, reads from SQLite with JSON fallback.
// Used as a transitional layer during JSON→SQLite migration.

import { config } from "../config.ts";
import type { Job } from "../jobs.ts";
import type { JobStore } from "./job-store.ts";
import { JsonStore } from "./json-store.ts";
import { SqliteStore } from "./sqlite-store.ts";

export class DualStore implements JobStore {
  private json: JsonStore;
  private sqlite: SqliteStore;

  constructor(
    jobsDir: string = config.jobsDir,
    dbPath: string = config.sqliteDbPath,
  ) {
    this.json = new JsonStore(jobsDir);
    this.sqlite = new SqliteStore(dbPath);

    // Lazy backfill: import any JSON-only jobs into SQLite on first init
    this.backfill();
  }

  private backfill(): void {
    const jsonJobs = this.json.list();
    if (jsonJobs.length === 0) return;

    const imported = this.sqlite.importJobs(jsonJobs);
    if (imported > 0) {
      process.stderr.write(`[codex-agent] Backfilled ${imported} jobs from JSON to SQLite\n`);
    }
  }

  save(job: Job): void {
    // Write to both — SQLite first (primary), then JSON (fallback)
    this.sqlite.save(job);
    this.json.save(job);
  }

  load(jobId: string): Job | null {
    // Read from SQLite first, fall back to JSON
    const job = this.sqlite.load(jobId);
    if (job) return job;
    return this.json.load(jobId);
  }

  list(): Job[] {
    // SQLite is authoritative after backfill
    return this.sqlite.list();
  }

  remove(jobId: string): boolean {
    // Remove from both
    const sqliteOk = this.sqlite.remove(jobId);
    const jsonOk = this.json.remove(jobId);
    return sqliteOk || jsonOk;
  }
}
