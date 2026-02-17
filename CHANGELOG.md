# Changelog

## [Unreleased] — P1 improvements

*In progress*

## [1.1.0] — 2026-02-17 — P0 Critical Fixes

### Security

- **Argv-safe tmux execution**: Replaced all `execSync` string interpolation with `spawnSync` argv arrays — eliminates command injection via malicious prompts
- **Launcher scripts**: Prompt text is read from `.prompt` files, never embedded in shell commands; launcher `.sh` scripts isolate all shell logic
- **Path boundary check**: `loadFiles` validates resolved paths stay within `baseDir`, preventing `../` traversal attacks
- **Restrictive permissions**: Job directory created with `0o700`, files written with `0o600` via atomic writes

### Fixed

- **Crash vs completion detection**: When tmux session disappears, checks log for completion marker — no marker = `failed` status with error message (previously all marked `completed`)
- **Negation pattern bug** (`-f "!pattern"`): Now correctly removes from both `files[]` array and `seen` Set (previously only removed from Set, files stayed in array)
- **Delete cleanup**: `deleteJob` now removes `.log`, `.turn-complete`, and `.sh` files (previously only `.json` and `.prompt`)
- **Unified CLI routes**: Default route now shares full `handleStartCommand()` pipeline with `start` command — gets file loading, codebase map, wait, and notify support
- **Removed blind "3" keypress**: Interactive mode no longer sends "3" to dismiss update prompt; uses `skip_update_check=true` config instead

### Added

- **`src/fs-utils.ts`**: Shared utilities for atomic file writes (`renameSync` pattern) and secure directory creation
- **`resultPreview` field**: Jobs store last 500 chars of output instead of full transcript (prevents OOM on large outputs)
- **File loading limits**: `maxFileCount=200` cap and default excludes (`node_modules`, `.git`, `dist`, `.codex`, `.next`, `__pycache__`)
- **OS-aware `script` invocation**: Interactive mode detects macOS (BSD) vs Linux (GNU) `script` syntax automatically
- **Exec mode reasoning effort**: `-r` flag now correctly passed to `codex exec` via `-c model_reasoning_effort=...`

### Changed

- **Atomic writes everywhere**: `saveJob`, `writeSignalFile`, `updateJobTurn`, `setJobTurnWorking` all use temp-file + `renameSync` to prevent torn writes
- **Shell quoting**: Replaced ad-hoc escaping with `shellQuote()` function using standard `'\''` technique
- **`job.result` deprecated**: Full output no longer embedded in JSON; use `output` command or `.log` file instead

### Upstream merge

- Merged upstream commit `635299f` (turn-aware orchestration): `notify-hook.ts`, `watcher.ts`, `await-turn` command, turn tracking fields in Job interface

Based on [kingbootoshi/codex-orchestrator](https://github.com/kingbootoshi/codex-orchestrator), forked at commit `fad8173`.

### Added

- **Dual execution modes**: Default `exec` mode uses `codex exec` for automatic completion; `--interactive` flag enables TUI mode with send support and idle detection
- **Idle detection** (interactive mode): Monitors `? for shortcuts` pattern in tmux pane + log mtime stability; auto-sends `/exit` after 30s grace period; false positive recovery when codex resumes work
- **`--interactive` CLI flag**: Enables TUI mode for jobs that need mid-task `send` communication
- **`isCodexIdle()` function**: Strips ANSI codes and checks for idle pattern in tmux pane output
- **`getExecApprovalFlag()` function**: Maps sandbox mode to `--full-auto` or `--dangerously-bypass-approvals-and-sandbox` for exec mode
- **Job interface fields**: `interactive`, `idleDetectedAt`, `exitSent` (all optional, backward compatible)
- **`model_reasoning_summary=concise`**: Added to exec mode command to reduce token usage (~30%)
- **Codex 5.3 prompt engineering guidance** in SKILL.md: XML constraint blocks (`<design_and_scope_constraints>`, `<context_loading>`, `<plan_first>`, `<output_verbosity_spec>`)
- **Exec vs interactive mode selection guide** in SKILL.md
- **`docs/usage-guide.md`**: Usage patterns for Claude Code (skill mode, manual CLI, P3→P4 workflow, mode selection)
- **`docs/codex-orchestrator-vs-opus-standalone.md`**: Comparison between standalone Opus 4.6 and Opus + Codex fleet

### Changed

- **`createSession()`**: Refactored for dual mode — exec uses `cat prompt | codex exec ... | tee`, interactive preserves `script` + TUI + send-keys flow
- **`sendToJob()`**: Returns `{sent: boolean, error?: string}` instead of `boolean`; blocks non-interactive (exec mode) jobs with error message; clears idle state on send
- **`refreshJobStatus()`**: Added idle detection branch for interactive jobs (grace period, log mtime check, `/exit` send, false positive recovery)
- **CLI help text**: Updated with modes section, `--interactive` flag, and exec/interactive examples
- **SKILL.md**: Added 5-stage pipeline improvements, prompt engineering section, reasoning effort guide, dual-mode error recovery
- **CODEBASE_MAP.md**: Updated from 8 files/9k tokens to 23 files/34k tokens; added session-parser, dual-mode data flows, idle detection documentation
- **Repository references**: All URLs changed from `kingbootoshi/codex-orchestrator` to `yelban/codex-orchestrator`

### Config additions

| Key | Value | Description |
|-----|-------|-------------|
| `idleDetectionEnabled` | `true` | Enable idle detection for interactive mode |
| `idleGracePeriodSeconds` | `30` | Seconds before idle detection triggers `/exit` |
