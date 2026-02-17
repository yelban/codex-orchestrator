// Spawn-based exec runner — runs codex exec as a detached child process.
// No tmux dependency. Tracks PID and exit code for accurate status detection.

import { spawn } from "child_process";
import { openSync, constants } from "fs";
import { join } from "path";
import { config } from "./config.ts";
import { atomicWriteFileSync, ensureDirSync } from "./fs-utils.ts";

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function getExecApprovalFlag(sandbox: string): string {
  switch (sandbox) {
    case "danger-full-access":
      return "--dangerously-bypass-approvals-and-sandbox";
    default:
      return "--full-auto";
  }
}

/**
 * Build launcher script that writes exit code to a file on completion.
 * Unlike the tmux variant, no `read` at the end — process exits immediately.
 */
function buildSpawnLauncher(opts: {
  promptFile: string;
  logFile: string;
  exitCodeFile: string;
  model: string;
  reasoningEffort: string;
  sandbox: string;
}): string {
  const q = shellQuote;
  const approvalFlag = getExecApprovalFlag(opts.sandbox);
  return [
    "#!/bin/bash",
    "set -uo pipefail",
    "",
    `cat ${q(opts.promptFile)} | codex exec \\`,
    `  -m ${q(opts.model)} \\`,
    `  -c model_reasoning_summary=concise \\`,
    `  -c model_reasoning_effort=${q(opts.reasoningEffort)} \\`,
    `  -s ${q(opts.sandbox)} \\`,
    `  ${approvalFlag} \\`,
    `  --json - 2>&1 | tee ${q(opts.logFile)}`,
    "EXIT_CODE=$?",
    "",
    `printf '\\n\\n[codex-agent: Session complete. Exit code: %d]\\n' $EXIT_CODE >> ${q(opts.logFile)}`,
    `echo $EXIT_CODE > ${q(opts.exitCodeFile)}`,
    "",
  ].join("\n");
}

export interface SpawnResult {
  pid: number;
  success: boolean;
  error?: string;
}

/**
 * Spawn a codex exec job as a detached background process.
 * Returns the PID for tracking. The process writes its exit code
 * to a `.exitcode` file upon completion.
 */
export function spawnExecJob(options: {
  jobId: string;
  prompt: string;
  model: string;
  reasoningEffort: string;
  sandbox: string;
  cwd: string;
}): SpawnResult {
  ensureDirSync(config.jobsDir);

  const promptFile = join(config.jobsDir, `${options.jobId}.prompt`);
  const logFile = join(config.jobsDir, `${options.jobId}.log`);
  const exitCodeFile = join(config.jobsDir, `${options.jobId}.exitcode`);
  const launcherFile = join(config.jobsDir, `${options.jobId}.sh`);

  // Write prompt file
  atomicWriteFileSync(promptFile, options.prompt);

  // Build and write launcher script
  const launcher = buildSpawnLauncher({
    promptFile,
    logFile,
    exitCodeFile,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    sandbox: options.sandbox,
  });
  atomicWriteFileSync(launcherFile, launcher, 0o700);

  try {
    // Open /dev/null for stdin, and a log file for stdout/stderr fallback
    const devNull = openSync("/dev/null", constants.O_RDONLY);

    const child = spawn("bash", [launcherFile], {
      cwd: options.cwd,
      detached: true,
      stdio: [devNull, "ignore", "ignore"],
      env: {
        ...process.env,
        model_reasoning_summary: "concise",
      },
    });

    const pid = child.pid;
    if (!pid) {
      return { pid: 0, success: false, error: "Failed to get PID from spawned process" };
    }

    // Unref so parent can exit without waiting
    child.unref();

    return { pid, success: true };
  } catch (err) {
    return { pid: 0, success: false, error: (err as Error).message };
  }
}

/**
 * Check if a process with the given PID is still running.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the exit code file left by a completed spawn job.
 * Returns the exit code, or null if the file doesn't exist yet.
 */
export function readExitCode(jobId: string): number | null {
  const exitCodeFile = join(config.jobsDir, `${jobId}.exitcode`);
  try {
    const { readFileSync } = require("fs");
    const content = readFileSync(exitCodeFile, "utf-8").trim();
    const code = parseInt(content, 10);
    return Number.isFinite(code) ? code : null;
  } catch {
    return null;
  }
}
