// tmux helper functions for codex-agent
// All tmux/shell commands use argv arrays (spawnSync) to prevent injection.

import { spawnSync } from "child_process";
import { platform } from "os";
import { join } from "path";
import { config } from "./config.ts";
import { atomicWriteFileSync } from "./fs-utils.ts";

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
  created: string;
}

// ---------- shell quoting for launcher scripts ----------

/**
 * Single-quote a string for safe embedding in bash scripts.
 * Handles embedded single quotes via the '\'' technique.
 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ---------- low-level tmux helpers ----------

/**
 * Run a tmux command via spawnSync (argv-safe, no shell).
 */
function tmuxRun(
  args: string[],
  opts?: { maxBuffer?: number }
): { ok: boolean; stdout: string } {
  const result = spawnSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: opts?.maxBuffer,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || "").toString(),
  };
}

/**
 * Get tmux session name for a job
 */
export function getSessionName(jobId: string): string {
  return `${config.tmuxPrefix}-${jobId}`;
}

/**
 * Check if tmux is available
 */
export function isTmuxAvailable(): boolean {
  const result = spawnSync("which", ["tmux"], { stdio: "pipe" });
  return result.status === 0;
}

/**
 * Check if a tmux session exists
 */
export function sessionExists(sessionName: string): boolean {
  return tmuxRun(["has-session", "-t", sessionName]).ok;
}

/**
 * Get the approval flag for codex exec based on sandbox mode
 */
function getExecApprovalFlag(sandbox: string): string {
  switch (sandbox) {
    case "danger-full-access":
      return "--dangerously-bypass-approvals-and-sandbox";
    default:
      return "--full-auto";
  }
}

// ---------- launcher script builders ----------

/**
 * @deprecated Used only when CODEX_AGENT_EXEC_RUNNER=tmux. The default spawn
 * runner (`src/spawn-runner.ts`) provides authoritative exit-code-based
 * completion detection and is preferred. Kept for backward compatibility.
 */
function buildExecLauncher(opts: {
  promptFile: string;
  logFile: string;
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
    "(",
    `  cat ${q(opts.promptFile)} | codex exec \\`,
    `    -m ${q(opts.model)} \\`,
    `    -c model_reasoning_summary=concise \\`,
    `    -c model_reasoning_effort=${q(opts.reasoningEffort)} \\`,
    `    -s ${q(opts.sandbox)} \\`,
    `    ${approvalFlag} \\`,
    `    --json - 2>&1`,
    `  printf '\\n\\n[codex-agent: Session complete]\\n'`,
    `) | tee ${q(opts.logFile)}`,
    "",
  ].join("\n");
}

function buildInteractiveLauncher(opts: {
  logFile: string;
  promptFile: string;
  model: string;
  reasoningEffort: string;
  sandbox: string;
  notifyHook: string;
  jobId: string;
}): string {
  const q = shellQuote;
  const notifyValue = `notify=["bun","run","${opts.notifyHook}","${opts.jobId}"]`;

  // Pass the prompt as a CLI positional arg via $(cat promptFile) so codex
  // receives it at launch — eliminates the fragile post-init send-keys path
  // that was getting swallowed by the TUI ("100% left" stuck state).
  const codexCmd = [
    "codex",
    "-c", q(`model=${opts.model}`),
    "-c", q(`model_reasoning_effort=${opts.reasoningEffort}`),
    "-c", q("skip_update_check=true"),
    "-c", q(notifyValue),
    "-a", "never",
    "-s", q(opts.sandbox),
    `"$(cat ${q(opts.promptFile)})"`,
  ].join(" ");

  // Chain printf after codex so the completion marker is captured INSIDE
  // `script` (otherwise it lands outside the PTY and never reaches the log,
  // leaving refreshTmuxJob unable to mark the job completed).
  const completionMarker = "printf '\\n\\n[codex-agent: Session complete]\\n'";
  const codexShell = `${codexCmd} ; ${completionMarker}`;

  const lines = ["#!/bin/bash", "set -uo pipefail", ""];

  if (platform() === "linux") {
    // GNU script: -e propagates child exit code; -c takes a shell command string.
    lines.push(`script -q -e -c ${q(codexShell)} ${q(opts.logFile)}`);
  } else {
    // BSD script (macOS): no -c flag; wrap the chain in `bash -c` so the
    // semicolon and quoting are interpreted as a shell command.
    lines.push(`script -q ${q(opts.logFile)} bash -c ${q(codexShell)}`);
  }
  lines.push("");

  return lines.join("\n");
}

// ---------- session lifecycle ----------

/**
 * Create a new tmux session running codex
 * - exec mode (default): uses `codex exec` for automatic completion
 * - interactive mode: uses `codex` TUI with idle detection for send support
 */
export function createSession(options: {
  jobId: string;
  prompt: string;
  model: string;
  reasoningEffort: string;
  sandbox: string;
  cwd: string;
  interactive?: boolean;
}): { sessionName: string; success: boolean; error?: string } {
  const sessionName = getSessionName(options.jobId);
  const logFile = join(config.jobsDir, `${options.jobId}.log`);
  const promptFile = join(config.jobsDir, `${options.jobId}.prompt`);
  const launcherFile = join(config.jobsDir, `${options.jobId}.sh`);
  const notifyHook = join(import.meta.dir, "notify-hook.ts");

  // Write prompt file
  atomicWriteFileSync(promptFile, options.prompt);

  // Build and write launcher script
  let launcher: string;
  if (options.interactive) {
    launcher = buildInteractiveLauncher({
      logFile,
      promptFile,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      sandbox: options.sandbox,
      notifyHook,
      jobId: options.jobId,
    });
  } else {
    launcher = buildExecLauncher({
      promptFile,
      logFile,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      sandbox: options.sandbox,
    });
  }

  atomicWriteFileSync(launcherFile, launcher, 0o700);

  try {
    // Create tmux session pointing to launcher script (argv-safe)
    const result = spawnSync(
      "tmux",
      ["new-session", "-d", "-s", sessionName, "-c", options.cwd, "bash", launcherFile],
      { stdio: "pipe" }
    );

    if (result.status !== 0) {
      const stderr = result.stderr?.toString() || "";
      return { sessionName, success: false, error: `tmux new-session failed: ${stderr}` };
    }

    // Interactive prompt is embedded in the launcher script via $(cat promptFile);
    // codex receives it at launch. Multi-turn follow-ups use sendMessage().
    return { sessionName, success: true };
  } catch (err) {
    return {
      sessionName,
      success: false,
      error: (err as Error).message,
    };
  }
}

// ---------- idle detection ----------

/**
 * Check if a codex interactive session is idle (waiting for input).
 * Only matches `? for shortcuts` when it appears as a standalone prompt
 * in the last few lines — not embedded in code, comments, or prompts.
 */
export function isCodexIdle(sessionName: string): boolean {
  const output = capturePane(sessionName, { lines: 5 });
  if (!output) return false;
  // Strip ANSI codes for reliable pattern matching
  const clean = output
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
  // Check last 5 lines for the idle prompt — must be at line start (after optional whitespace/glyphs)
  const lines = clean.split("\n").slice(-5);
  return lines.some((line) => {
    const trimmed = line.trim();
    return trimmed === "? for shortcuts" || /^[>›\s]*\?\s+for shortcuts/.test(trimmed);
  });
}

// ---------- message sending ----------

/**
 * Send a message to a running codex session
 */
export function sendMessage(sessionName: string, message: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    // send-keys -l: literal mode, no key name interpretation
    spawnSync("tmux", ["send-keys", "-t", sessionName, "-l", message], {
      stdio: "pipe",
    });
    spawnSync("sleep", ["0.3"]);
    spawnSync("tmux", ["send-keys", "-t", sessionName, "Enter"], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a control key to a session (like C-c)
 */
export function sendControl(sessionName: string, key: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    // No -l flag: key names like C-c are interpreted
    spawnSync("tmux", ["send-keys", "-t", sessionName, key], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

// ---------- output capture ----------

/**
 * Capture the current pane content
 */
export function capturePane(
  sessionName: string,
  options: { lines?: number; start?: number } = {}
): string | null {
  if (!sessionExists(sessionName)) {
    return null;
  }

  const args = ["capture-pane", "-t", sessionName, "-p"];

  if (options.start !== undefined) {
    args.push("-S", String(options.start));
  }

  const result = tmuxRun(args);
  if (!result.ok) return null;

  const output = result.stdout;
  if (options.lines) {
    const allLines = output.split("\n");
    return allLines.slice(-options.lines).join("\n");
  }

  return output;
}

/**
 * Get the full scrollback buffer
 */
export function captureFullHistory(sessionName: string): string | null {
  if (!sessionExists(sessionName)) {
    return null;
  }

  const result = tmuxRun(
    ["capture-pane", "-t", sessionName, "-p", "-S", "-"],
    { maxBuffer: 50 * 1024 * 1024 }
  );
  return result.ok ? result.stdout : null;
}

// ---------- session management ----------

/**
 * Kill a tmux session
 */
export function killSession(sessionName: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  return tmuxRun(["kill-session", "-t", sessionName]).ok;
}

/**
 * List all codex-agent sessions
 */
export function listSessions(): TmuxSession[] {
  const format = "#{session_name}|#{session_attached}|#{session_windows}|#{session_created}";
  const result = tmuxRun(["list-sessions", "-F", format]);
  if (!result.ok || !result.stdout.trim()) return [];

  return result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.startsWith(config.tmuxPrefix))
    .map((line) => {
      const [name, attached, windows, created] = line.split("|");
      return {
        name,
        attached: attached === "1",
        windows: parseInt(windows, 10),
        created: new Date(parseInt(created, 10) * 1000).toISOString(),
      };
    });
}

/**
 * Get the command to attach to a session (for display to user)
 */
export function getAttachCommand(sessionName: string): string {
  return `tmux attach -t "${sessionName}"`;
}

/**
 * Kill codex-agent tmux sessions that are not present in `activeSessionNames`.
 * Sessions younger than `graceSec` are skipped to avoid racing freshly created sessions.
 * Returns the count of sessions killed.
 */
export function cleanupOrphanedSessions(
  activeSessionNames: Set<string>,
  graceSec: number = 30,
): number {
  const now = Date.now();
  const graceMs = graceSec * 1000;
  let killed = 0;

  for (const session of listSessions()) {
    if (activeSessionNames.has(session.name)) continue;
    const ageMs = now - Date.parse(session.created);
    if (Number.isNaN(ageMs) || ageMs < graceMs) continue;
    if (killSession(session.name)) killed++;
  }

  return killed;
}

/**
 * Check if the session's codex process is still running
 */
export function isSessionActive(sessionName: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  const result = tmuxRun([
    "list-panes",
    "-t",
    sessionName,
    "-F",
    "#{pane_pid}",
  ]);
  if (!result.ok) return false;

  const pid = result.stdout.trim();
  if (!pid) return false;

  try {
    process.kill(parseInt(pid, 10), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Watch a session's output (returns a stream of updates)
 * This is for programmatic watching - for interactive use, just attach
 */
export function watchSession(
  sessionName: string,
  callback: (content: string) => void,
  intervalMs: number = 1000
): { stop: () => void } {
  let lastContent = "";
  let running = true;

  const interval = setInterval(() => {
    if (!running) return;

    const content = capturePane(sessionName, { lines: 100 });
    if (content && content !== lastContent) {
      // Only send the new lines
      const newContent = content.replace(lastContent, "").trim();
      if (newContent) {
        callback(newContent);
      }
      lastContent = content;
    }

    // Check if session still exists
    if (!sessionExists(sessionName)) {
      running = false;
      clearInterval(interval);
    }
  }, intervalMs);

  return {
    stop: () => {
      running = false;
      clearInterval(interval);
    },
  };
}
