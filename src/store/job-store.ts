// JobStore interface — abstracts job metadata persistence.
// Signal file operations stay file-based (transient, used by external notify hook process).

import type { Job } from "../jobs.ts";

export interface JobStore {
  save(job: Job): void;
  load(jobId: string): Job | null;
  list(): Job[];
  remove(jobId: string): boolean;
}
