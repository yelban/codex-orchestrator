# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Notes that complement Claude Code's built-in guidance. Apply to code work; for non-code tasks (writing, docs, design), use judgment.

## Stop when confused

If a request is ambiguous, name what is unclear and ask. Do not pick an interpretation silently. This applies *before* writing code, not after the fact.

## Every changed line should trace to the request

Before reporting done, re-read your own diff. If a line does not directly serve the user's stated goal, remove it. This is the working definition of "surgical changes."

## Loop on declarative goals

When the user gives a verifiable end state (tests pass, output matches, lint clean, benchmark below X), drive toward it autonomously. When they give imperative steps, follow them.

If the request is imperative but an obvious success criterion exists, propose the declarative version first ("I can verify this by Y — okay to drive toward that?") rather than guessing.

Users can invoke this reframing explicitly with the `dec` slash command: `/dec <request>` when installed standalone, or `/andrej-karpathy-skills:dec <request>` when installed via the plugin. See README for install options.

## 程式碼結構查詢路由

優先順序（從上到下匹配）：

1. **概念性 / 自然語言提問**（「X 怎麼實作的？」「Y 邏輯在哪？」）
   → 用 Semble MCP

2. **特定語法結構**（「找所有沒帶 deps 的 useEffect」「找所有 try/catch 沒處理的 await」）
   → 用 `sg run -p '<pattern>' -l <lang>`

3. **Call graph / impact / API 路由**（若已裝 CodeGraph）
   - 「改這個 function 會影響哪？」 → `codegraph_impact`
   - 「誰呼叫 X？」「X 呼叫了誰？」 → `codegraph_callers` / `codegraph_callees`
   - 「這個 URL endpoint 的 handler 在哪？」（Django / Express / FastAPI / Rails 等）→ `codegraph_search`

4. **精準符號操作 / rename / 跨檔 refactor**（若已裝 Serena）
   → 用 Serena MCP（`find_symbol` / `find_referencing_symbols` / `replace_symbol_body`）

5. **純字串 / regex**
   → 用 `rg`（最快、最後手段也最常用）

禁忌：
- 不要先 `rg` 再 `Read` 一堆檔案找概念——直接問 Semble。
- 不要用 `rg` 找符號定義或呼叫者，會被註解 / 字串 / 相似命名誤判。
- 不要用 `rg` 估算「改 X 影響範圍」——用 CodeGraph 的 `codegraph_impact` 才精準。

CodeGraph vs Serena 取向：CodeGraph 偏「讀取分析」（callers / impact），Serena 偏「寫入操作」（rename / replace）。沒裝的工具自動跳過該層、回退到下一層。

## Overview

CLI tool for delegating tasks to GPT Codex and Gemini agents. Exec mode uses detached `child_process.spawn` (no tmux); interactive mode uses tmux TUI. Designed for Claude Code orchestration with bidirectional communication.

**Stack**: TypeScript, Bun, SQLite (bun:sqlite), tmux (interactive only), OpenAI Codex CLI, Gemini CLI

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
    → src/config.ts (defaults: model, reasoning, sandbox, timeout, storage, runner, provider)
```

**Data flow (exec mode, default — spawn runner)**: `start` writes prompt to `.prompt` file → generates provider-specific launcher `.sh` script (OpenAI or Gemini) → spawns detached `bash <launcher>` via `child_process.spawn` → launcher pipes prompt to `codex exec` or `gemini` via `tee` → provider auto-completes → exit code written to `.exitcode` file via `PIPESTATUS[0]` → `refreshJobStatus` checks PID liveness + exit code for accurate completion/failure detection.

**Data flow (exec mode — tmux runner fallback, `@deprecated`)**: Same as above but runs inside a detached tmux session. Set `CODEX_AGENT_EXEC_RUNNER=tmux` to use. Marker string `[codex-agent: Session complete` captured via `(codex exec ... ; printf marker) | tee log` so log always contains it; refreshTmuxJob detects completion from log. Spawn runner is preferred.

**Data flow (interactive mode, `--interactive`)**: Always uses tmux. `start` writes prompt to `.prompt` file → generates OS-aware launcher `.sh` script → creates detached tmux session → launcher starts `codex` TUI with prompt as positional CLI arg via `"$(cat promptFile)"` (no send-keys for initial prompt). Linux uses `script -q -e -c` (exit-code propagating), macOS uses `script -q log bash -c`. Marker captured inside `script` for reliable completion detection. Idle detection monitors for completion via `.turn-complete` signal file (notify hook) with `? for shortcuts` string fallback.

**Storage**: Job metadata stored via `JobStore` abstraction. Default `dual` mode writes to both JSON files + SQLite (WAL mode), reads from SQLite with JSON fallback. Auto-backfills JSON→SQLite on first init. Override with `CODEX_AGENT_STORAGE=json|sqlite`.

**Job enrichment** (`jobs --json`): For completed jobs, enrichment data (tokens, files, summary) is cached in the job record after first parse. Subsequent calls read from cache, skipping the recursive `~/.codex/sessions/` scan.

## Key Behaviors & Gotchas

- **Multi-provider support**: `--provider openai|gemini` selects provider. Default `openai`. Gemini uses spawn runner only (no tmux, no interactive).
- **Gemini defaults**: When `--provider gemini`, auto-applies `sandbox=read-only`, `model=gemini-3.1-pro-preview`, `noConstraints=true` unless explicitly overridden.
- **Gemini hard max runtime**: Gemini jobs killed after `geminiHardMaxRuntimeMinutes` (default 30 min) to prevent silent hangs.
- **Gemini enrichment**: Skipped — session-parser only handles Codex JSONL format. `tokens`, `files_modified`, `summary` are `null` for Gemini jobs.
- **Dual modes + dual runners**: Exec mode defaults to spawn runner (no tmux); interactive mode always uses tmux TUI. Set `CODEX_AGENT_EXEC_RUNNER=tmux` for legacy exec behavior.
- **Completion detection (exec/spawn)**: Process exit → exit code file checked via `PIPESTATUS[0]`; exit 0 = completed, non-zero = failed. Exit code is authoritative — completion marker does NOT override non-zero exits.
- **Completion detection (exec/tmux)**: Marker string `[codex-agent: Session complete` in log/pane output
- **Completion detection (interactive)**: Idle detection — reads `.turn-complete` signal file from notify hook (authoritative); falls back to `? for shortcuts` pane string match for jobs without the hook. Both gated on 30s grace + log mtime stable → auto-sends `/exit`
- **Trust dialog auto-onboard**: `codex-trust.ts:ensureTrustedProject` writes `[projects."<cwd>"] trust_level = "trusted"` to `~/.codex/config.toml` before each job start so codex 0.133.0+ does not block on the trust dialog. Existing sections (any `trust_level`) are left untouched.
- **Auto-constraint injection**: `<design_and_scope_constraints>` and `<context_loading>` XML blocks auto-appended to all prompts (with dedup detection); opt-out with `--no-constraints`. Gemini auto-disables constraints.
- **Idle detection safety**: 30s grace period, log mtime stability check, `exitSent` flag prevents duplicates, false positive recovery when codex resumes; `--keep-alive` disables auto-exit entirely
- **send command**: Only works for `--interactive` jobs; exec mode jobs reject send with error; also blocked when `/exit` already sent. **Known fragility**: multi-turn `send` still uses tmux send-keys / load-buffer (codex CLI has no alternative API for live injection) — short prompts work, but anything that races codex's input handler can drop characters. For reliable multi-step work, prefer one fresh job per phase over long-lived multi-turn.
- **Launcher scripts**: Each job generates a `.sh` launcher script; tmux runs `bash <launcher>` — user prompts never embedded in shell commands
- **Argv-safe execution**: All tmux commands use `spawnSync` with argv arrays (no shell interpolation)
- **Atomic writes**: All JSON/signal file writes use temp-file + `renameSync` pattern (via `src/fs-utils.ts`)
- **Crash detection**: When tmux session disappears, log is checked for completion marker; no marker = `failed` status
- **Hardcoded delays**: Multi-turn `send` still uses `sleep 0.3` between paste and Enter for TUI sync; initial prompt no longer needs this since it goes through codex CLI arg.
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
| model | `gpt-5.5` |
| defaultReasoningEffort | `high` |
| defaultSandbox | `workspace-write` |
| defaultTimeout | 60 minutes |
| interactiveTimeout | 120 minutes |
| idleDetectionEnabled | `true` |
| idleGracePeriodSeconds | `30` |
| pendingJobTimeoutMinutes | `5` |
| storageMode | `dual` (env: `CODEX_AGENT_STORAGE`) |
| execRunner | `spawn` (env: `CODEX_AGENT_EXEC_RUNNER`) |
| provider | `openai` (env: `CODEX_AGENT_PROVIDER`) |
| geminiDefaultModel | `gemini-3.1-pro-preview` (env: `CODEX_AGENT_GEMINI_MODEL`) |
| geminiHardMaxRuntimeMinutes | `30` (env: `CODEX_AGENT_GEMINI_HARD_MAX_MINUTES`) |
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

## Codebase Overview

CLI tool for delegating tasks to GPT Codex and Gemini agents, designed as a Claude Code orchestration layer with bidirectional communication.

**Stack**: TypeScript, Bun, SQLite (bun:sqlite, WAL), tmux (interactive only), OpenAI Codex CLI, Gemini CLI
**Structure**: `src/cli.ts` (command router) → `src/jobs.ts` (lifecycle) → spawn-runner (provider-routed) or tmux → `src/store/` (DualStore default) → `~/.codex-agent/`

For detailed architecture, see [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md).

## Claude Orchestration Pattern (Persisted)

- Use `codex-agent start "<task>"` without `--wait` for background orchestration.
- Use `codex-agent start "<task>" --provider gemini` for Gemini jobs.
- Track job IDs immediately.
- Use `codex-agent await-turn <id>` to block until agent finishes current turn (preferred).
- Use `codex-agent status <id>` to check running/completed state.
- Use `codex-agent capture <id> [n]` for incremental tails while running.
- Use `codex-agent output <id>` for final transcript after completion.
- Multi-provider patterns (parallel analysis, generate→review, specialist routing) are documented in SKILL.md.
