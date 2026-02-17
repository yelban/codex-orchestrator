// Job management for async codex agent execution with tmux/spawn

import { readFileSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { config, ReasoningEffort, SandboxMode } from "./config.ts";
import { randomBytes } from "crypto";
import { extractSessionId, findSessionFile, parseSessionFile, type ParsedSessionData } from "./session-parser.ts";
import { getStore } from "./store/index.ts";
import {
  createSession,
  killSession,
  sessionExists,
  getSessionName,
  capturePane,
  captureFullHistory,
  isSessionActive,
  sendMessage,
  sendControl,
  isCodexIdle,
} from "./tmux.ts";
import { spawnExecJob, isProcessAlive, readExitCode } from "./spawn-runner.ts";
import { clearSignalFile, signalFileExists, readSignalFile, type TurnEvent } from "./watcher.ts";

export interface Job {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  prompt: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  sandbox: SandboxMode;
  parentSessionId?: string;
  cwd: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  tmuxSession?: string;
  pid?: number; // spawn-mode: process ID
  exitCode?: number; // spawn-mode: exit code after completion
  runner?: "tmux" | "spawn"; // which runner launched this job
  result?: string; // deprecated: no longer written, kept for backward compat
  resultPreview?: string; // last 500 chars of output
  error?: string;
  interactive?: boolean;
  idleDetectedAt?: string;
  exitSent?: boolean;
  keepAlive?: boolean;
  // Turn tracking
  turnCount?: number;
  lastTurnCompletedAt?: string;
  lastAgentMessage?: string;
  turnState?: "working" | "idle" | "context_limit";
  // Cached enrichment data (written once after completion)
  enrichment?: {
    tokens: ParsedSessionData["tokens"];
    filesModified: string[] | null;
    summary: string | null;
    enrichedAt: string;
  };
}

function generateJobId(): string {
  return randomBytes(4).toString("hex");
}

export function saveJob(job: Job): void {
  getStore().save(job);
}

export function loadJob(jobId: string): Job | null {
  return getStore().load(jobId);
}

export function listJobs(): Job[] {
  return getStore().list();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

function computeElapsedMs(job: Job): number {
  const start = job.startedAt ?? job.createdAt;
  const startMs = Date.parse(start);
  const endMs = job.completedAt ? Date.parse(job.completedAt) : Date.now();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, endMs - startMs);
}

function getLogMtimeMs(jobId: string): number | null {
  const logFile = join(config.jobsDir, `${jobId}.log`);
  try {
    return statSync(logFile).mtimeMs;
  } catch {
    return null;
  }
}

function getLastActivityMs(job: Job): number | null {
  const logMtime = getLogMtimeMs(job.id);
  if (logMtime !== null) return logMtime;

  const fallback = job.startedAt ?? job.createdAt;
  const fallbackMs = Date.parse(fallback);
  if (!Number.isFinite(fallbackMs)) return null;
  return fallbackMs;
}

function isInactiveTimedOut(job: Job): boolean {
  const timeoutMinutes = job.interactive ? config.interactiveTimeout : config.defaultTimeout;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return false;

  const lastActivityMs = getLastActivityMs(job);
  if (!lastActivityMs) return false;

  return Date.now() - lastActivityMs > timeoutMinutes * 60 * 1000;
}

function loadSessionData(jobId: string): ParsedSessionData | null {
  const logFile = join(config.jobsDir, `${jobId}.log`);
  let logContent: string;

  try {
    logContent = readFileSync(logFile, "utf-8");
  } catch {
    return null;
  }

  const sessionId = extractSessionId(logContent);
  if (!sessionId) return null;

  const sessionFile = findSessionFile(sessionId);
  if (!sessionFile) return null;

  return parseSessionFile(sessionFile);
}

export type JobsJsonEntry = {
  id: string;
  status: Job["status"];
  prompt: string;
  model: string;
  reasoning: ReasoningEffort;
  cwd: string;
  elapsed_ms: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  tokens: ParsedSessionData["tokens"] | null;
  files_modified: ParsedSessionData["files_modified"] | null;
  summary: string | null;
};

export type JobsJsonOutput = {
  generated_at: string;
  jobs: JobsJsonEntry[];
};

export function getJobsJson(): JobsJsonOutput {
  const jobs = listJobs();
  const enriched = jobs.map((job) => {
    const refreshed = job.status === "running" ? refreshJobStatus(job.id) : null;
    const effective = refreshed ?? job;
    const elapsedMs = computeElapsedMs(effective);

    let tokens: ParsedSessionData["tokens"] | null = null;
    let filesModified: ParsedSessionData["files_modified"] | null = null;
    let summary: string | null = null;

    if (effective.status === "completed") {
      if (effective.enrichment) {
        // Use cached enrichment data (avoids repeated session file scans)
        tokens = effective.enrichment.tokens;
        filesModified = effective.enrichment.filesModified;
        summary = effective.enrichment.summary;
      } else {
        // First time: parse session data and cache in job JSON
        const sessionData = loadSessionData(effective.id);
        if (sessionData) {
          tokens = sessionData.tokens;
          filesModified = sessionData.files_modified;
          summary = sessionData.summary ? truncateText(sessionData.summary, 500) : null;
          effective.enrichment = {
            tokens: sessionData.tokens,
            filesModified: sessionData.files_modified,
            summary: sessionData.summary ? truncateText(sessionData.summary, 500) : null,
            enrichedAt: new Date().toISOString(),
          };
          saveJob(effective);
        }
      }
    }

    return {
      id: effective.id,
      status: effective.status,
      prompt: truncateText(effective.prompt, 100),
      model: effective.model,
      reasoning: effective.reasoningEffort,
      cwd: effective.cwd,
      elapsed_ms: elapsedMs,
      created_at: effective.createdAt,
      started_at: effective.startedAt ?? null,
      completed_at: effective.completedAt ?? null,
      tokens,
      files_modified: filesModified,
      summary,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    jobs: enriched,
  };
}

export function deleteJob(jobId: string): boolean {
  const job = loadJob(jobId);

  // Kill tmux session if running
  if (job?.tmuxSession && sessionExists(job.tmuxSession)) {
    killSession(job.tmuxSession);
  }

  // Remove job from store
  const removed = getStore().remove(jobId);

  // Clean up auxiliary files (.prompt, .log, .turn-complete, .sh, .exitcode)
  const auxiliaryExtensions = [".prompt", ".log", ".turn-complete", ".sh", ".exitcode"];
  for (const ext of auxiliaryExtensions) {
    try {
      unlinkSync(join(config.jobsDir, `${jobId}${ext}`));
    } catch {
      // File may not exist
    }
  }

  return removed;
}

export interface StartJobOptions {
  prompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandbox?: SandboxMode;
  parentSessionId?: string;
  cwd?: string;
  interactive?: boolean;
  keepAlive?: boolean;
}

export function startJob(options: StartJobOptions): Job {
  const jobId = generateJobId();
  const cwd = options.cwd || process.cwd();

  // Determine runner: spawn for exec mode (when configured), tmux for interactive or default
  const useSpawn = config.execRunner === "spawn" && !options.interactive;

  const job: Job = {
    id: jobId,
    status: "pending",
    prompt: options.prompt,
    model: options.model || config.model,
    reasoningEffort: options.reasoningEffort || config.defaultReasoningEffort,
    sandbox: options.sandbox || config.defaultSandbox,
    parentSessionId: options.parentSessionId,
    cwd,
    createdAt: new Date().toISOString(),
    interactive: options.interactive || false,
    keepAlive: options.keepAlive || false,
    runner: useSpawn ? "spawn" : "tmux",
  };

  saveJob(job);

  if (useSpawn) {
    // Spawn-based exec: detached child process, no tmux
    const result = spawnExecJob({
      jobId,
      prompt: options.prompt,
      model: job.model,
      reasoningEffort: job.reasoningEffort,
      sandbox: job.sandbox,
      cwd,
    });

    if (result.success) {
      job.status = "running";
      job.startedAt = new Date().toISOString();
      job.pid = result.pid;
      job.turnState = "working";
    } else {
      job.status = "failed";
      job.error = result.error || "Failed to spawn exec process";
      job.completedAt = new Date().toISOString();
    }
  } else {
    // Tmux-based: create tmux session (both exec and interactive modes)
    const result = createSession({
      jobId,
      prompt: options.prompt,
      model: job.model,
      reasoningEffort: job.reasoningEffort,
      sandbox: job.sandbox,
      cwd,
      interactive: options.interactive,
    });

    if (result.success) {
      job.status = "running";
      job.startedAt = new Date().toISOString();
      job.tmuxSession = result.sessionName;
      job.turnState = "working";
    } else {
      job.status = "failed";
      job.error = result.error || "Failed to create tmux session";
      job.completedAt = new Date().toISOString();
    }
  }

  saveJob(job);
  return job;
}

export function killJob(jobId: string): boolean {
  const job = loadJob(jobId);
  if (!job) return false;

  // Kill by runner type
  if (job.runner === "spawn" && job.pid) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  } else if (job.tmuxSession) {
    killSession(job.tmuxSession);
  }

  clearSignalFile(jobId);
  job.status = "failed";
  job.error = "Killed by user";
  job.completedAt = new Date().toISOString();
  saveJob(job);
  return true;
}

export function sendToJob(jobId: string, message: string): { sent: boolean; error?: string } {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return { sent: false, error: "Job not found or no tmux session" };

  if (!job.interactive) {
    return { sent: false, error: "Cannot send to non-interactive (exec mode) job. Use --interactive when starting the job." };
  }

  if (job.exitSent) {
    return { sent: false, error: "Session is closing (/exit already sent). Start a new job instead, or use --keep-alive to prevent auto-exit." };
  }

  const ok = sendMessage(job.tmuxSession, message);
  if (!ok) return { sent: false, error: "Failed to send message to tmux session" };

  // Clear idle detection state and turn-complete signal when sending a new message
  job.idleDetectedAt = undefined;
  job.exitSent = undefined;
  clearSignalFile(jobId);
  job.turnState = "working";
  saveJob(job);

  return { sent: true };
}

export function sendControlToJob(jobId: string, key: string): boolean {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return false;

  return sendControl(job.tmuxSession, key);
}

export function getJobOutput(jobId: string, lines?: number): string | null {
  const job = loadJob(jobId);
  if (!job) return null;

  // First try tmux capture if session exists
  if (job.tmuxSession && sessionExists(job.tmuxSession)) {
    const output = capturePane(job.tmuxSession, { lines });
    if (output) return output;
  }

  // Fall back to log file
  const logFile = join(config.jobsDir, `${jobId}.log`);
  try {
    const content = readFileSync(logFile, "utf-8");
    if (lines) {
      const allLines = content.split("\n");
      return allLines.slice(-lines).join("\n");
    }
    return content;
  } catch {
    return null;
  }
}

export function getJobFullOutput(jobId: string): string | null {
  const job = loadJob(jobId);
  if (!job) return null;

  // First try tmux capture if session exists
  if (job.tmuxSession && sessionExists(job.tmuxSession)) {
    const output = captureFullHistory(job.tmuxSession);
    if (output) return output;
  }

  // Fall back to log file
  const logFile = join(config.jobsDir, `${jobId}.log`);
  try {
    return readFileSync(logFile, "utf-8");
  } catch {
    return null;
  }
}

export function cleanupOldJobs(maxAgeDays: number = 7): number {
  const jobs = listJobs();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const job of jobs) {
    const jobTime = new Date(job.completedAt || job.createdAt).getTime();
    if (jobTime < cutoff && (job.status === "completed" || job.status === "failed")) {
      if (deleteJob(job.id)) cleaned++;
    }
  }

  return cleaned;
}

export function isJobRunning(jobId: string): boolean {
  const job = loadJob(jobId);
  if (!job) return false;

  if (job.runner === "spawn" && job.pid) {
    return isProcessAlive(job.pid);
  }
  if (job.tmuxSession) {
    return isSessionActive(job.tmuxSession);
  }
  return false;
}

export function refreshJobStatus(jobId: string): Job | null {
  const job = loadJob(jobId);
  if (!job) return null;

  if (job.status !== "running") return job;

  // Route by runner type
  if (job.runner === "spawn" && job.pid) {
    refreshSpawnJob(job);
  } else if (job.tmuxSession) {
    refreshTmuxJob(job);
  }

  return loadJob(jobId);
}

/** Refresh status for spawn-mode jobs (exec via child_process). */
function refreshSpawnJob(job: Job): void {
  if (!job.pid) return;

  if (isProcessAlive(job.pid)) {
    // Still running — check inactivity timeout
    if (isInactiveTimedOut(job)) {
      try { process.kill(job.pid, "SIGTERM"); } catch { /* already gone */ }
      job.status = "failed";
      job.error = `Timed out after ${config.defaultTimeout} minutes of inactivity`;
      job.completedAt = new Date().toISOString();
      saveJob(job);
    }
    return;
  }

  // Process exited — determine success/failure via exit code
  job.completedAt = new Date().toISOString();
  const exitCode = readExitCode(job.id);
  job.exitCode = exitCode ?? undefined;

  const logFile = join(config.jobsDir, `${job.id}.log`);
  let logContent: string | null = null;
  try {
    logContent = readFileSync(logFile, "utf-8");
  } catch { /* no log */ }

  if (exitCode === 0) {
    job.status = "completed";
  } else if (logContent && logContent.includes("[codex-agent: Session complete")) {
    job.status = "completed";
  } else {
    job.status = "failed";
    job.error = exitCode !== null
      ? `Process exited with code ${exitCode}`
      : "Process exited unexpectedly (no exit code file)";
  }

  if (logContent) {
    job.resultPreview = logContent.slice(-500);
  }
  saveJob(job);
}

/** Refresh status for tmux-based jobs (both exec and interactive). */
function refreshTmuxJob(job: Job): void {
  if (!job.tmuxSession) return;

  if (!sessionExists(job.tmuxSession)) {
    // Session ended — check log for completion marker to distinguish success vs crash
    job.completedAt = new Date().toISOString();
    const logFile = join(config.jobsDir, `${job.id}.log`);
    let logContent: string | null = null;
    try {
      logContent = readFileSync(logFile, "utf-8");
    } catch { /* no log */ }

    if (logContent && logContent.includes("[codex-agent: Session complete")) {
      job.status = "completed";
    } else {
      job.status = "failed";
      job.error = "Session ended unexpectedly (possible crash, OOM, or killed process)";
    }
    if (logContent) {
      job.resultPreview = logContent.slice(-500);
    }
    saveJob(job);
    return;
  }

  // Session exists — check for completion marker
  const output = capturePane(job.tmuxSession, { lines: 20 });
  if (output && output.includes("[codex-agent: Session complete")) {
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    job.resultPreview = output.slice(-500);
    saveJob(job);
  } else if (job.interactive && config.idleDetectionEnabled && !job.exitSent && !job.keepAlive) {
    // Idle detection for interactive jobs only
    const idle = isCodexIdle(job.tmuxSession);

    if (idle) {
      if (!job.idleDetectedAt) {
        job.idleDetectedAt = new Date().toISOString();
        saveJob(job);
      } else {
        const idleSinceMs = Date.now() - Date.parse(job.idleDetectedAt);
        const logMtime = getLogMtimeMs(job.id);
        const logStable = logMtime !== null
          ? (Date.now() - logMtime) > config.idleGracePeriodSeconds * 1000
          : true;

        if (idleSinceMs >= config.idleGracePeriodSeconds * 1000 && logStable) {
          sendMessage(job.tmuxSession, "/exit");
          job.exitSent = true;
          saveJob(job);
        }
      }
    } else if (job.idleDetectedAt) {
      job.idleDetectedAt = undefined;
      saveJob(job);
    }
  } else if (isInactiveTimedOut(job)) {
    killSession(job.tmuxSession);
    job.status = "failed";
    job.error = `Timed out after ${config.defaultTimeout} minutes of inactivity`;
    job.completedAt = new Date().toISOString();
    saveJob(job);
  }
}

export function isJobIdle(jobId: string): boolean {
  return signalFileExists(jobId);
}

export function getTurnSignal(jobId: string): TurnEvent | null {
  return readSignalFile(jobId);
}

export function getAttachCommand(jobId: string): string | null {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return null;

  return `tmux attach -t "${job.tmuxSession}"`;
}
