# Changelog

## [Unreleased] — yelban/codex-orchestrator fork

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
