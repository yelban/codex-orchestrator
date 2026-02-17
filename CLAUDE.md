# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

CLI tool for delegating tasks to GPT Codex agents via tmux sessions. Designed for Claude Code orchestration with bidirectional communication.

**Stack**: TypeScript, Bun, tmux, OpenAI Codex CLI

## Development

```bash
bun run src/cli.ts --help          # Run directly
bun run src/cli.ts health          # Health check (verifies tmux + codex)
./bin/codex-agent --help           # Via shell wrapper
bun build src/cli.ts --outdir dist --target node  # Build
bun install                        # Install dependencies
```

Bun is the TypeScript runtime — never use npm/yarn/pnpm for running.

No test suite exists. No linter configured.

## Architecture

```
bin/codex-agent (shell wrapper)
  → src/cli.ts (command parsing + routing)
    → src/jobs.ts (job lifecycle, persistence to ~/.codex-agent/jobs/)
      → src/tmux.ts (tmux session create/send/capture/kill)
      → src/session-parser.ts (parse Codex JSONL sessions for tokens/files/summary)
    → src/files.ts (glob-based file loading for context injection)
    → src/config.ts (defaults: model, reasoning, sandbox, timeout)
```

**Data flow (exec mode, default)**: `start` creates a detached tmux session → pipes prompt to `codex exec` via `tee` (for logging) → codex auto-completes → marker string triggers → job marked completed.

**Data flow (interactive mode, `--interactive`)**: `start` creates a detached tmux session → launches `codex` TUI via `script` (for output logging) → sends prompt via `send-keys` (or `load-buffer` for >5000 chars) → returns job ID. Idle detection monitors for completion (30s grace period). Output retrieval tries tmux pane capture first, falls back to `.log` file.

**Job enrichment** (`jobs --json`): For completed jobs, `session-parser.ts` extracts the Codex session ID from the log file, finds the corresponding JSONL in `~/.codex/sessions/`, and parses token usage, modified files (from `apply_patch` tool calls), and last assistant message as summary.

## Key Behaviors & Gotchas

- **Dual modes**: Default `exec` mode uses `codex exec` (auto-completes, no send). `--interactive` uses TUI (supports send, idle detection)
- **Completion detection (exec)**: `codex exec` exits naturally → marker string `[codex-agent: Session complete` appears → job completed
- **Completion detection (interactive)**: Idle detection — `? for shortcuts` pattern in pane + log mtime stable for 30s → auto-sends `/exit`
- **Idle detection safety**: 30s grace period, log mtime stability check, `exitSent` flag prevents duplicates, false positive recovery when codex resumes
- **send command**: Only works for `--interactive` jobs; exec mode jobs reject send with error message
- **Update prompt skip**: Interactive mode sends "3" then Enter after session creation to dismiss Codex update prompts
- **Hardcoded delays**: Interactive mode uses `sleep` (0.3–1s) between tmux commands for TUI sync — fragile but necessary
- **Shell escaping**: Single quotes in prompts escaped as `'\''`
- **Inactivity timeout**: Running jobs with no log file activity for 60 minutes are auto-killed (fallback for both modes)
- **Log files**: Contain ANSI terminal codes; use `--strip-ansi` for clean output
- **50MB buffer limit**: `captureFullHistory` maxBuffer is 50MB

## Plugin Structure

This repo doubles as a Claude Code plugin marketplace:

```
.claude-plugin/marketplace.json        # marketplace registry
plugins/codex-orchestrator/
  .claude-plugin/plugin.json           # plugin metadata
  skills/codex-orchestrator/SKILL.md   # skill instructions for Claude
  scripts/install.sh                   # dependency installer
```

## Config Defaults (src/config.ts)

| Key | Value |
|-----|-------|
| model | `gpt-5.3-codex` |
| defaultReasoningEffort | `xhigh` |
| defaultSandbox | `workspace-write` |
| defaultTimeout | 60 minutes |
| idleDetectionEnabled | `true` |
| idleGracePeriodSeconds | `30` |
| jobsDir | `~/.codex-agent/jobs/` |
| tmuxPrefix | `codex-agent` |

## Storage

```
~/.codex-agent/jobs/
  <jobId>.json           # Job metadata (status, model, timestamps, turn tracking)
  <jobId>.prompt         # Original prompt text
  <jobId>.log            # Full terminal output from script command
  <jobId>.turn-complete  # Signal file from notify hook (transient)
```

Job IDs: 8 random hex chars. Session names: `codex-agent-<jobId>`.

## Claude Orchestration Pattern (Persisted)

- Use `codex-agent start "<task>"` without `--wait` for background orchestration.
- Track job IDs immediately.
- Use `codex-agent await-turn <id>` to block until agent finishes current turn (preferred).
- Use `codex-agent status <id>` to check running/completed state.
- Use `codex-agent capture <id> [n]` for incremental tails while running.
- Use `codex-agent output <id>` for final transcript after completion.
