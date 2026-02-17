// tmux helper functions for codex-agent

import { execSync, spawnSync } from "child_process";
import { config } from "./config.ts";

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
  created: string;
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
  try {
    execSync("which tmux", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a tmux session exists
 */
export function sessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the approval flag for codex exec based on sandbox mode
 */
function getExecApprovalFlag(sandbox: string): string {
  switch (sandbox) {
    case "danger-full-access":
      return "--dangerously-bypass-approvals-and-sandbox";
    case "read-only":
      return "--full-auto";
    default:
      // workspace-write and others
      return "--full-auto";
  }
}

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
  const logFile = `${config.jobsDir}/${options.jobId}.log`;
  const notifyHook = `${import.meta.dir}/notify-hook.ts`;

  // Create prompt file to avoid shell escaping issues
  const promptFile = `${config.jobsDir}/${options.jobId}.prompt`;
  const fs = require("fs");
  fs.writeFileSync(promptFile, options.prompt);

  try {
    let shellCmd: string;

    if (options.interactive) {
      // Interactive mode: use codex TUI (supports send, idle detection, notify hook)
      const codexArgs = [
        `-c`, `model="${options.model}"`,
        `-c`, `model_reasoning_effort="${options.reasoningEffort}"`,
        `-c`, `skip_update_check=true`,
        `-c`, `'\\''notify=["bun","run","${notifyHook}","${options.jobId}"]'\\''`,
        `-a`, `never`,
        `-s`, options.sandbox,
      ].join(" ");

      shellCmd = `script -q "${logFile}" codex ${codexArgs}; echo "\\n\\n[codex-agent: Session complete. Press Enter to close.]"; read`;
    } else {
      // Exec mode (default): codex exec auto-completes, pipe through tee for logging
      const approvalFlag = getExecApprovalFlag(options.sandbox);
      shellCmd = `cat "${promptFile}" | codex exec -m "${options.model}" -c model_reasoning_summary="concise" -s "${options.sandbox}" ${approvalFlag} --json - 2>&1 | tee "${logFile}"; echo "\\n\\n[codex-agent: Session complete. Press Enter to close.]"; read`;
    }

    execSync(
      `tmux new-session -d -s "${sessionName}" -c "${options.cwd}" '${shellCmd}'`,
      { stdio: "pipe", cwd: options.cwd }
    );

    if (options.interactive) {
      // Interactive mode: handle update prompt and send the initial prompt
      spawnSync("sleep", ["1"]);

      // Skip update prompt if it appears by sending "3" (skip until next version)
      execSync(`tmux send-keys -t "${sessionName}" "3"`, { stdio: "pipe" });
      spawnSync("sleep", ["0.5"]);
      execSync(`tmux send-keys -t "${sessionName}" Enter`, { stdio: "pipe" });
      spawnSync("sleep", ["1"]);

      // Send the prompt
      const promptContent = options.prompt.replace(/'/g, "'\\''");

      if (options.prompt.length < 5000) {
        execSync(
          `tmux send-keys -t "${sessionName}" '${promptContent}'`,
          { stdio: "pipe" }
        );
        spawnSync("sleep", ["0.3"]);
        execSync(
          `tmux send-keys -t "${sessionName}" Enter`,
          { stdio: "pipe" }
        );
      } else {
        execSync(`tmux load-buffer "${promptFile}"`, { stdio: "pipe" });
        execSync(`tmux paste-buffer -t "${sessionName}"`, { stdio: "pipe" });
        spawnSync("sleep", ["0.3"]);
        execSync(`tmux send-keys -t "${sessionName}" Enter`, { stdio: "pipe" });
      }
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
 * Check if a codex interactive session is idle (waiting for input)
 */
export function isCodexIdle(sessionName: string): boolean {
  const output = capturePane(sessionName, { lines: 10 });
  if (!output) return false;
  // Strip ANSI codes for reliable pattern matching
  const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  return clean.includes('? for shortcuts');
}

/**
 * Send a message to a running codex session
 */
export function sendMessage(sessionName: string, message: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    const escapedMessage = message.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t "${sessionName}" '${escapedMessage}'`, {
      stdio: "pipe",
    });
    // Small delay before Enter for TUI to process
    spawnSync("sleep", ["0.3"]);
    execSync(`tmux send-keys -t "${sessionName}" Enter`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a control key to a session (like Ctrl+C)
 */
export function sendControl(sessionName: string, key: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    execSync(`tmux send-keys -t "${sessionName}" ${key}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

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

  try {
    let cmd = `tmux capture-pane -t "${sessionName}" -p`;

    if (options.start !== undefined) {
      cmd += ` -S ${options.start}`;
    }

    const output = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });

    if (options.lines) {
      const allLines = output.split("\n");
      return allLines.slice(-options.lines).join("\n");
    }

    return output;
  } catch {
    return null;
  }
}

/**
 * Get the full scrollback buffer
 */
export function captureFullHistory(sessionName: string): string | null {
  if (!sessionExists(sessionName)) {
    return null;
  }

  try {
    // Capture from start of history (-S -) to end
    const output = execSync(
      `tmux capture-pane -t "${sessionName}" -p -S -`,
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }
    );
    return output;
  } catch {
    return null;
  }
}

/**
 * Kill a tmux session
 */
export function killSession(sessionName: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    execSync(`tmux kill-session -t "${sessionName}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * List all codex-agent sessions
 */
export function listSessions(): TmuxSession[] {
  try {
    const output = execSync(
      `tmux list-sessions -F "#{session_name}|#{session_attached}|#{session_windows}|#{session_created}" 2>/dev/null`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );

    return output
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
  } catch {
    return [];
  }
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

  try {
    // Check if the pane has a running process
    const pid = execSync(
      `tmux list-panes -t "${sessionName}" -F "#{pane_pid}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    if (!pid) return false;

    // Check if that process is still running
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
