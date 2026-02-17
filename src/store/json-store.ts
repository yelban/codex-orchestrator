// JSON file-based JobStore implementation — wraps the original persistence logic.

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { config } from "../config.ts";
import { atomicWriteFileSync, ensureDirSync } from "../fs-utils.ts";
import type { Job } from "../jobs.ts";
import type { JobStore } from "./job-store.ts";

export class JsonStore implements JobStore {
  private readonly dir: string;

  constructor(dir: string = config.jobsDir) {
    this.dir = dir;
    ensureDirSync(this.dir);
  }

  private path(jobId: string): string {
    return join(this.dir, `${jobId}.json`);
  }

  save(job: Job): void {
    atomicWriteFileSync(this.path(job.id), JSON.stringify(job, null, 2));
  }

  load(jobId: string): Job | null {
    try {
      const content = readFileSync(this.path(jobId), "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  list(): Job[] {
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    return files
      .map((f) => {
        try {
          const content = readFileSync(join(this.dir, f), "utf-8");
          return JSON.parse(content) as Job;
        } catch {
          return null;
        }
      })
      .filter((j): j is Job => j !== null)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  remove(jobId: string): boolean {
    const { unlinkSync } = require("fs");
    try {
      unlinkSync(this.path(jobId));
      return true;
    } catch {
      return false;
    }
  }
}
