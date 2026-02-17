# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

CLI tool for delegating tasks to GPT Codex agents. Exec mode uses detached `child_process.spawn` (no tmux); interactive mode uses tmux TUI. Designed for Claude Code orchestration with bidirectional communication.

**Stack**: TypeScript, Bun, SQLite (bun:sqlite), tmux (interactive only), OpenAI Codex CLI

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
    → src/jobs.ts (job lifecycle, store abstraction)
      → src/store/ (JobStore interface + JsonStore, SqliteStore, DualStore)
      → src/tmux.ts (tmux session create/send/capture/kill — interactive only)
      → src/spawn-runner.ts (detached child_process — exec mode default)
      → src/session-parser.ts (parse Codex JSONL sessions for tokens/files/summary)
      → src/watcher.ts (turn-complete signal files, notify hook integration)
    → src/files.ts (glob-based file loading with path boundary checks)
    → src/prompt-constraints.ts (auto-inject XML constraint blocks)
    → src/fs-utils.ts (atomic writes, secure directory creation)
    → src/config.ts (defaults: model, reasoning, sandbox, timeout, storage, runner)
```

**Data flow (exec mode, default — spawn runner)**: `start` writes prompt to `.prompt` file → generates launcher `.sh` script → spawns detached `bash <launcher>` via `child_process.spawn` → launcher pipes prompt to `codex exec` via `tee` → codex auto-completes → exit code written to `.exitcode` file → `refreshJobStatus` checks PID liveness + exit code for accurate completion/failure detection.

**Data flow (exec mode — tmux runner fallback)**: Same as above but runs inside a detached tmux session. Set `CODEX_AGENT_EXEC_RUNNER=tmux` to use. Marker string `[codex-agent: Session complete` used for completion detection.

**Data flow (interactive mode, `--interactive`)**: Always uses tmux. `start` writes prompt to `.prompt` file → generates OS-aware launcher `.sh` script → creates detached tmux session → launcher starts `codex` TUI via `script` (BSD/GNU auto-detected) → prompt sent via `send-keys` (or `load-buffer` for >5000 chars) → returns job ID. Idle detection monitors for completion (30s grace period).

**Storage**: Job metadata stored via `JobStore` abstraction. Default `dual` mode writes to both JSON files + SQLite (WAL mode), reads from SQLite with JSON fallback. Auto-backfills JSON→SQLite on first init. Override with `CODEX_AGENT_STORAGE=json|sqlite`.

**Job enrichment** (`jobs --json`): For completed jobs, enrichment data (tokens, files, summary) is cached in the job record after first parse. Subsequent calls read from cache, skipping the recursive `~/.codex/sessions/` scan.

## Key Behaviors & Gotchas

- **Dual modes + dual runners**: Exec mode defaults to spawn runner (no tmux); interactive mode always uses tmux TUI. Set `CODEX_AGENT_EXEC_RUNNER=tmux` for legacy exec behavior.
- **Completion detection (exec/spawn)**: Process exit → exit code file checked; exit 0 = completed, non-zero = failed with error message
- **Completion detection (exec/tmux)**: Marker string `[codex-agent: Session complete` in log/pane output
- **Completion detection (interactive)**: Idle detection — `? for shortcuts` pattern matched at line start in last 5 pane lines + log mtime stable for 30s → auto-sends `/exit`
- **Auto-constraint injection**: `<design_and_scope_constraints>` and `<context_loading>` XML blocks auto-appended to all prompts (with dedup detection); opt-out with `--no-constraints`
- **Idle detection safety**: 30s grace period, log mtime stability check, `exitSent` flag prevents duplicates, false positive recovery when codex resumes; `--keep-alive` disables auto-exit entirely
- **send command**: Only works for `--interactive` jobs; exec mode jobs reject send with error; also blocked when `/exit` already sent
- **Launcher scripts**: Each job generates a `.sh` launcher script; tmux runs `bash <launcher>` — user prompts never embedded in shell commands
- **Argv-safe execution**: All tmux commands use `spawnSync` with argv arrays (no shell interpolation)
- **Atomic writes**: All JSON/signal file writes use temp-file + `renameSync` pattern (via `src/fs-utils.ts`)
- **Crash detection**: When tmux session disappears, log is checked for completion marker; no marker = `failed` status
- **Hardcoded delays**: Interactive mode uses `sleep` (0.3–1s) between tmux commands for TUI sync — fragile but necessary
- **Shell quoting in launchers**: `shellQuote()` function uses standard `'\''` technique for safe embedding in bash scripts
- **Inactivity timeout**: Exec mode: 60 min, interactive mode: 120 min — auto-killed on log inactivity
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
| interactiveTimeout | 120 minutes |
| idleDetectionEnabled | `true` |
| idleGracePeriodSeconds | `30` |
| storageMode | `dual` (env: `CODEX_AGENT_STORAGE`) |
| execRunner | `spawn` (env: `CODEX_AGENT_EXEC_RUNNER`) |
| sqliteDbPath | `~/.codex-agent/codex-agent.db` |
| maxFileCount | `200` |
| defaultExcludes | `node_modules, .git, dist, .codex, .next, __pycache__` |
| jobsDir | `~/.codex-agent/jobs/` |
| tmuxPrefix | `codex-agent` |

## Storage

```
~/.codex-agent/
  codex-agent.db               # SQLite database (WAL mode)
  jobs/                        # Created with 0o700 permissions
    <jobId>.json               # Job metadata JSON (dual-write, 0o600)
    <jobId>.prompt             # Original prompt text
    <jobId>.log                # Full terminal output
    <jobId>.sh                 # Launcher script (generated per job)
    <jobId>.exitcode           # Exit code from spawn runner
    <jobId>.turn-complete      # Signal file from notify hook (transient)
```

Job IDs: 8 random hex chars. Session names: `codex-agent-<jobId>`.

CLI management: `codex-agent migrate` (JSON→SQLite bulk import), `codex-agent verify-storage` (sync check).

## Claude Orchestration Pattern (Persisted)

- Use `codex-agent start "<task>"` without `--wait` for background orchestration.
- Track job IDs immediately.
- Use `codex-agent await-turn <id>` to block until agent finishes current turn (preferred).
- Use `codex-agent status <id>` to check running/completed state.
- Use `codex-agent capture <id> [n]` for incremental tails while running.
- Use `codex-agent output <id>` for final transcript after completion.
