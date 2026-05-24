#!/usr/bin/env bun

import { appendTurnLog, writeSignalFile, type TurnEvent } from "./watcher.ts";

type NotifyPayload = {
  type?: string;
  [key: string]: unknown;
};

function parsePayload(raw: string): NotifyPayload | null {
  try {
    return JSON.parse(raw) as NotifyPayload;
  } catch {
    return null;
  }
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toStringOrFallback(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function main(): void {
  const jobId = process.argv[2];
  const rawPayload = process.argv[3];
  if (!jobId || !rawPayload) return;

  const payload = parsePayload(rawPayload);
  if (!payload || payload.type !== "agent-turn-complete") return;

  const event: TurnEvent = {
    turnId: toStringOrFallback(payload["turn-id"]),
    lastAgentMessage: toStringOrNull(payload["last-assistant-message"]),
    timestamp: new Date().toISOString(),
  };

  // Notify-hook is intentionally fire-and-forget toward job.json — only the
  // CLI process writes there, to avoid the read-modify-write race that the
  // previous updateJobTurn call introduced. The signal file gives await-turn
  // the latest event; the JSONL log gives the CLI an exact turn count on
  // next refresh.
  writeSignalFile(jobId, event);
  appendTurnLog(jobId, event);
}

main();
