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
    "set -euo pipefail",
    "",
    `cat ${q(opts.promptFile)} | codex exec \\`,
    `  -m ${q(opts.model)} \\`,
    `  -c model_reasoning_summary=concise \\`,
    `  -c model_reasoning_effort=${q(opts.reasoningEffort)} \\`,
    `  -s ${q(opts.sandbox)} \\`,
    `  ${approvalFlag} \\`,
    `  --json - 2>&1 | tee ${q(opts.logFile)}`,
    "",
    "printf '\\n\\n[codex-agent: Session complete. Press Enter to close.]\\n'",
    "read",
    "",
  ].join("\n");
}

function buildInteractiveLauncher(opts: {
  logFile: string;
  model: string;
  reasoningEffort: string;
  sandbox: string;
  notifyHook: string;
  jobId: string;
}): string {
  const q = shellQuote;
  const notifyValue = `notify=["bun","run","${opts.notifyHook}","${opts.jobId}"]`;

  // Build the codex command parts (each properly quoted for bash)
  const codexCmd = [
    "codex",
    "-c", q(`model=${opts.model}`),
    "-c", q(`model_reasoning_effort=${opts.reasoningEffort}`),
    "-c", q("skip_update_check=true"),
    "-c", q(notifyValue),
    "-a", "never",
    "-s", q(opts.sandbox),
  ].join(" ");

  const lines = ["#!/bin/bash", "set -euo pipefail", ""];

  if (platform() === "linux") {
    // GNU script: script -q -c "command" logfile
    lines.push(`script -q -c ${q(codexCmd)} ${q(opts.logFile)}`);
  } else {
    // BSD script (macOS): script -q logfile command args...
    lines.push(`script -q ${q(opts.logFile)} ${codexCmd}`);
  }

  lines.push("");
  lines.push("printf '\\n\\n[codex-agent: Session complete. Press Enter to close.]\\n'");
  lines.push("read");
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

    if (options.interactive) {
      // Wait for TUI to initialize, then send the initial prompt
      // skip_update_check=true eliminates the need to send "3" to dismiss update prompt
      spawnSync("sleep", ["1"]);
      sendPromptToSession(sessionName, options.prompt, promptFile);
    }

    return { sessionName, success: true };
  } catch (err) {
    return {
      sessionName,
      success: false,
      error: (err as Error).message,
    };
  }
}

/**
 * Send the initial prompt to an interactive codex session.
 * Uses tmux send-keys -l (literal) for short prompts,
 * load-buffer + paste-buffer for long ones.
 */
function sendPromptToSession(
  sessionName: string,
  prompt: string,
  promptFile: string
): void {
  if (prompt.length < 5000) {
    // send-keys -l sends literal text (no key name interpretation)
    spawnSync("tmux", ["send-keys", "-t", sessionName, "-l", prompt], {
      stdio: "pipe",
    });
  } else {
    // For long prompts, use load-buffer from the prompt file
    spawnSync("tmux", ["load-buffer", promptFile], { stdio: "pipe" });
    spawnSync("tmux", ["paste-buffer", "-t", sessionName], { stdio: "pipe" });
  }
  spawnSync("sleep", ["0.3"]);
  spawnSync("tmux", ["send-keys", "-t", sessionName, "Enter"], {
    stdio: "pipe",
  });
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
