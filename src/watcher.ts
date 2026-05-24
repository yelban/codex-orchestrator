import { appendFileSync, readFileSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { config } from "./config.ts";
import { atomicWriteFileSync } from "./fs-utils.ts";

export interface TurnEvent {
  turnId: string;
  lastAgentMessage: string | null;
  timestamp: string;
}

function getSignalPath(jobId: string): string {
  return join(config.jobsDir, `${jobId}.turn-complete`);
}

function getTurnLogPath(jobId: string): string {
  return join(config.jobsDir, `${jobId}.turn-log.jsonl`);
}

export function writeSignalFile(jobId: string, event: TurnEvent): void {
  atomicWriteFileSync(getSignalPath(jobId), JSON.stringify(event));
}

export function readSignalFile(jobId: string): TurnEvent | null {
  try {
    const content = readFileSync(getSignalPath(jobId), "utf-8");
    return JSON.parse(content) as TurnEvent;
  } catch {
    return null;
  }
}

export function clearSignalFile(jobId: string): void {
  try {
    unlinkSync(getSignalPath(jobId));
  } catch {
    // File may not exist
  }
}

export function signalFileExists(jobId: string): boolean {
  try {
    statSync(getSignalPath(jobId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Append a turn event to the per-job JSONL log. POSIX guarantees atomic
 * writes < PIPE_BUF for `O_APPEND`; each event is one short JSON line so
 * concurrent appends from notify-hook subprocesses are safe.
 */
export function appendTurnLog(jobId: string, event: TurnEvent): void {
  appendFileSync(getTurnLogPath(jobId), JSON.stringify(event) + "\n", { mode: 0o600 });
}

export function countTurnLogLines(jobId: string): number {
  try {
    const content = readFileSync(getTurnLogPath(jobId), "utf-8");
    if (!content) return 0;
    return content.split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}
