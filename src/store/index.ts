// Store factory — returns the configured JobStore implementation.

import { config } from "../config.ts";
import type { JobStore } from "./job-store.ts";
import { JsonStore } from "./json-store.ts";

let _store: JobStore | null = null;

export function getStore(): JobStore {
  if (_store) return _store;

  const mode = config.storageMode;

  switch (mode) {
    case "sqlite": {
      const { SqliteStore } = require("./sqlite-store.ts");
      _store = new SqliteStore(config.sqliteDbPath);
      break;
    }
    case "dual": {
      const { DualStore } = require("./dual-store.ts");
      _store = new DualStore(config.jobsDir, config.sqliteDbPath);
      break;
    }
    case "json":
    default:
      _store = new JsonStore(config.jobsDir);
      break;
  }

  return _store!;
}

export { type JobStore } from "./job-store.ts";
export { JsonStore } from "./json-store.ts";
