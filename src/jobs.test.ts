import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { config } from "./config.ts";
import { applyTurnSignal, type Job } from "./jobs.ts";

let originalJobsDir: string;
let tmpJobsDir: string;

beforeEach(() => {
  originalJobsDir = config.jobsDir;
  tmpJobsDir = mkdtempSync(join(tmpdir(), "jobs-test-"));
  (config as { jobsDir: string }).jobsDir = tmpJobsDir;
});

afterEach(() => {
  (config as { jobsDir: string }).jobsDir = originalJobsDir;
  rmSync(tmpJobsDir, { recursive: true, force: true });
});

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "test01",
    status: "running",
    prompt: "x",
    model: "gpt-5.5",
    reasoningEffort: "high",
    sandbox: "workspace-write",
    cwd: "/tmp",
    createdAt: new Date().toISOString(),
    interactive: true,
    ...overrides,
  };
}

function writeSignal(jobId: string, turnId: string, lastAgentMessage: string | null, timestamp = "2026-01-01T00:00:00.000Z") {
  writeFileSync(
    join(tmpJobsDir, `${jobId}.turn-complete`),
    JSON.stringify({ turnId, lastAgentMessage, timestamp }),
  );
}

function appendLog(jobId: string, turnId: string, lastAgentMessage: string | null = null) {
  const event = { turnId, lastAgentMessage, timestamp: "2026-01-01T00:00:00.000Z" };
  appendFileSync(join(tmpJobsDir, `${jobId}.turn-log.jsonl`), JSON.stringify(event) + "\n");
}

describe("applyTurnSignal", () => {
  test("returns false and leaves job alone when no signal file exists", () => {
    const job = makeJob();
    expect(applyTurnSignal(job)).toBe(false);
    expect(job.turnState).toBeUndefined();
    expect(job.turnCount).toBeUndefined();
    expect(job.lastAgentMessage).toBeUndefined();
  });

  test("applies fresh signal: writes all fields, turnCount = log line count", () => {
    writeSignal("test01", "turn-1", "hello");
    appendLog("test01", "turn-1", "hello");

    const job = makeJob();
    expect(applyTurnSignal(job)).toBe(true);
    expect(job.turnState).toBe("idle");
    expect(job.lastAgentMessage).toBe("hello");
    expect(job.lastObservedTurnId).toBe("turn-1");
    expect(job.lastTurnCompletedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(job.turnCount).toBe(1);
  });

  test("idempotent: same turnId returns false, job unchanged", () => {
    writeSignal("test01", "turn-1", "hello");
    appendLog("test01", "turn-1", "hello");

    const job = makeJob();
    applyTurnSignal(job);
    const before = JSON.stringify(job);

    expect(applyTurnSignal(job)).toBe(false);
    expect(JSON.stringify(job)).toBe(before);
  });

  test("new turnId on top of old: applies, turnCount reflects log line count", () => {
    writeSignal("test01", "turn-1", "first");
    appendLog("test01", "turn-1", "first");

    const job = makeJob();
    applyTurnSignal(job);
    expect(job.turnCount).toBe(1);

    // Simulate codex finishing a second turn
    writeSignal("test01", "turn-2", "second", "2026-01-01T00:01:00.000Z");
    appendLog("test01", "turn-2", "second");

    expect(applyTurnSignal(job)).toBe(true);
    expect(job.lastObservedTurnId).toBe("turn-2");
    expect(job.lastAgentMessage).toBe("second");
    expect(job.turnCount).toBe(2);
  });

  test("turnCount tracks log file lines even when not all signals applied", () => {
    // Three turns appended, but only the latest signal is current
    appendLog("test01", "turn-1");
    appendLog("test01", "turn-2");
    appendLog("test01", "turn-3");
    writeSignal("test01", "turn-3", "latest");

    const job = makeJob();
    expect(applyTurnSignal(job)).toBe(true);
    expect(job.turnCount).toBe(3);
    expect(job.lastObservedTurnId).toBe("turn-3");
  });

  test("truncates long lastAgentMessage to 500 chars", () => {
    const long = "x".repeat(800);
    writeSignal("test01", "turn-1", long);
    appendLog("test01", "turn-1", long);

    const job = makeJob();
    applyTurnSignal(job);
    expect(job.lastAgentMessage?.length).toBe(500);
  });

  test("null lastAgentMessage becomes undefined", () => {
    writeSignal("test01", "turn-1", null);
    appendLog("test01", "turn-1");

    const job = makeJob();
    applyTurnSignal(job);
    expect(job.lastAgentMessage).toBeUndefined();
  });
});
