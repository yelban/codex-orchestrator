# Codex Orchestrator

<p align="center">
  <img src="codex-agent-hero.jpeg" alt="Claude orchestrating Codex agents" width="600">
</p>

Delegate tasks to OpenAI Codex agents. Exec mode uses detached processes (no tmux required); interactive mode uses tmux TUI. Designed for Claude Code orchestration.

Spawn parallel coding agents, monitor their progress, and capture results — all from Claude Code or the command line. Supports two execution modes: **exec** (default, spawn runner, auto-completes) and **interactive** (tmux TUI with send support and idle detection). Job metadata stored in SQLite (WAL mode) with JSON fallback.

> **Workflow / Ultrawork ready** — drive `codex-agent` from inside a Claude Code Workflow script (`agent()` / `parallel()` / `pipeline()`) under the `ultrawork` opt-in, getting sandbox isolation, progress tracking, and multi-provider routing for free. See [§ Workflow / Ultrawork Integration](#workflow--ultrawork-integration).

## Workflow / Ultrawork Integration

Claude Code's Workflow tool spawns Claude subagents that have Bash access. Inside any Workflow `agent()` call, the subagent can run `codex-agent` to delegate coding tasks — instead of writing the implementation inline. The intermediate Claude layer handles prompt shaping, provider routing, and output parsing; `codex-agent` does the heavy lifting.

**Activation** — include `ultrawork` in your user message (or invoke a Workflow-using skill). The Claude Code harness then authorizes the Workflow tool. No installation needed beyond the prerequisites below.

**Prerequisites**

- `.claude/settings.json` Bash whitelist needs `Bash(codex-agent:*)` (one wildcard covers all subcommands)
- Use **exec mode** (default) — never `--interactive` from a Workflow (no human at the keyboard)
- Gemini jobs have `null` for `tokens` / `files_modified` / `summary` — handle in your output parser

**Two canonical idioms**

Single blocking task (subagent waits inline, simplest):

```bash
codex-agent start "<task>" --wait
codex-agent output <id>
```

Background fan-out (>5 parallel tasks — avoids blocking subagent processes):

```bash
id1=$(codex-agent start "Analyze auth module")
id2=$(codex-agent start "Audit error handling")
id3=$(codex-agent start --provider gemini "Cross-check findings")

codex-agent await-turn $id1 && codex-agent output $id1
codex-agent await-turn $id2 && codex-agent output $id2
codex-agent await-turn $id3 && codex-agent output $id3
```

For deeper orchestration patterns, conditional routing, and gotchas: see [`CLAUDE.md` → Workflow / Ultrawork Integration](CLAUDE.md#workflow--ultrawork-integration).

## Installation

### As a Claude Code Plugin (Recommended)

**Step 1:** Add the marketplace:

```
/plugin marketplace add yelban/codex-orchestrator
```

**Step 2:** Install the plugin:

```
/plugin install codex-orchestrator
```

**Step 3:** Restart Claude Code (may be required for the skill to load)

**Step 4:** Install the CLI and dependencies:

```
/codex-orchestrator init
```

Or say "set up codex orchestrator" and Claude will walk you through it.

**Step 5:** Use it - just ask Claude to do things. The skill activates automatically for coding tasks.

### Manual / CLI-Only Install

If you just want the `codex-agent` CLI without the Claude Code plugin:

```bash
# Prerequisites
brew install tmux              # macOS (or apt/pacman/dnf for Linux)
npm install -g @openai/codex   # OpenAI Codex CLI
codex --login                  # Authenticate with OpenAI

# Install
git clone https://github.com/yelban/codex-orchestrator.git ~/.codex-orchestrator
cd ~/.codex-orchestrator && bun install

# Add to PATH (add this line to ~/.bashrc or ~/.zshrc)
export PATH="$HOME/.codex-orchestrator/bin:$PATH"

# Verify
codex-agent health
```

Or use the automated installer:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/yelban/codex-orchestrator/main/plugins/codex-orchestrator/scripts/install.sh)
```

### Requirements

| Dependency | Purpose | Install |
|-----------|---------|---------|
| [tmux](https://github.com/tmux/tmux) | Terminal multiplexer - interactive mode only (exec mode doesn't need it) | `brew install tmux` |
| [Bun](https://bun.sh) | JavaScript runtime - runs the CLI | `curl -fsSL https://bun.sh/install \| bash` |
| [Codex CLI](https://github.com/openai/codex) | OpenAI's coding agent - the thing being orchestrated | `npm install -g @openai/codex` |
| OpenAI account | API access for Codex agents | `codex --login` |

**Platform support:** macOS and Linux. Windows users should use WSL.

## macOS Notes

Two macOS-specific gotchas that can block first-time setup. Hit either of these
and your first `codex-agent` job will hang or fail.

### 1. Directory trust (first time in a new project)

Codex CLI v0.133+ requires explicit trust for each working directory. The TUI
prompt — "Do you trust the contents of this directory?" — cannot be answered
from `codex-agent` exec mode. The agent will hang at the prompt and the only
recovery is `codex-agent kill <id>` (status will show `FAILED`).

**Solution:** Pre-trust new directories by editing `~/.codex/config.toml`:

```toml
[projects."/Users/you/path/to/project"]
trust_level = "trusted"
```

Or run `codex` interactively once in the new directory and press `y` — that
writes the same entry automatically.

Inspect current trusted directories:

```bash
grep '^\[projects' ~/.codex/config.toml
```

### 2. Claude Code sandbox blocks `configd`

When `codex-agent` is invoked from inside Claude Code, the harness sandbox can
block Unix socket access to macOS `configd` (used by `system-configuration` for
DNS). The Rust binary then panics:

```
thread 'main' panicked at system-configuration crate ...
```

**Solution A (per-call):** Pass `dangerouslyDisableSandbox: true` to every
Bash invocation that runs `codex-agent`. This is safe because `codex-agent`
manages its own sandbox via `-s` flag — the Claude Code outer sandbox is
redundant here.

```
Bash(codex-agent start "..." --map, dangerouslyDisableSandbox: true)
Bash(codex-agent await-turn <id>, dangerouslyDisableSandbox: true)
```

**Solution B (permanent, recommended):** Add an exclusion to
`~/.claude/settings.json`:

```json
"sandbox": {
  "excludedCommands": ["codex", "codex-agent", "codex-bg"]
}
```

After saving, restart Claude Code to apply.

### 3. PATH doesn't pick up in current Claude Code session

The install script appends `export PATH=...` to `~/.zshrc`, but the currently
running Claude Code session was launched with the old environment — so
`which codex-agent` returns "not found" inside that session even though it
exists on disk.

Three workarounds:

| Solution | When to use |
|---|---|
| Restart Claude Code | Best long-term — every new session picks up the new PATH |
| Use absolute path `~/.codex-orchestrator/bin/codex-agent` | Need it working right now in current session |
| Open a fresh terminal | If running CLI outside Claude Code |

## Why?

When you're working with Claude Code and need parallel execution, investigation tasks, or long-running operations - spawn Codex agents in the background. They run in tmux sessions so you can:

- **Watch live** - Attach to any session and see exactly what the agent is doing
- **Talk back** - Send follow-up messages mid-task to redirect or add context
- **Run in parallel** - Spawn multiple agents investigating different parts of a codebase
- **Capture results** - Grab output programmatically when agents finish

Claude handles the strategic thinking (planning, synthesis, communication). Codex handles the deep coding work (research, implementation, review, testing). Together they cover both the orchestration and execution layers.

## Codebase Map (Recommended)

The `--map` flag injects `docs/CODEBASE_MAP.md` into every agent's prompt, giving them instant understanding of your entire codebase: file purposes, module boundaries, data flows, dependencies, and navigation guides.

Without a map, agents waste time exploring and guessing at structure. With a map, they know exactly where things are and start working immediately.

The map is generated by [Cartographer](https://github.com/kingbootoshi/cartographer), a companion Claude Code plugin:

```
/plugin marketplace add kingbootoshi/cartographer
/plugin install cartographer
/cartographer
```

This creates `docs/CODEBASE_MAP.md`. After that, every `codex-agent start ... --map` command gives agents full architectural context. **Generate a codebase map before using codex-orchestrator on a new project** - it's the difference between agents that fumble around and agents that execute with precision.

## Quick Start

```bash
# Start an agent (exec mode — auto-completes when done)
codex-agent start "Review this codebase for security vulnerabilities" --map
codex-agent start "Refactor auth module" --wait --notify-on-complete 'printf "\033[0;32mCodex agent done\033[0m\n"'

# Start in interactive mode (supports send for mid-task redirection)
codex-agent start "Analyze the auth module" --map --interactive

# Check status with structured JSON
codex-agent jobs --json

# See what it's doing
codex-agent capture <jobId>

# Redirect the agent mid-task (interactive only)
codex-agent send <jobId> "Focus on the authentication module instead"
```

### Hello World (Verify Installation)

A safe read-only test against any repo to confirm setup end-to-end:

```bash
cd /path/to/some/repo

# Spawn a read-only research agent
JOB=$(codex-agent start "List top-level files and summarize the README in one sentence." \
  --map -s read-only -r high 2>&1 \
  | grep -oE 'Job started: [a-f0-9]{8}' | awk '{print $3}')
echo "Job: $JOB"

# Block until agent responds (typically 30s-2min for simple tasks)
codex-agent await-turn "$JOB"

# Parse and print the agent's actual response text
codex-agent output "$JOB" | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line.startswith('{'): continue
    try: e = json.loads(line)
    except: continue
    if e.get('type') == 'item.completed' and e.get('item', {}).get('type') == 'agent_message':
        print(e['item']['text']); print()
"
```

> **Why parse JSON for the response?** `status` and `capture` only show
> metadata or raw TUI noise. The agent's actual text response lives in the
> `output` JSON event stream as `item.completed` events with
> `item.type == "agent_message"`.

**Typical metrics** for a read-only 2-file research task (gpt-5.5 high):

| Metric | Value |
|---|---|
| Duration | ~30-60 seconds |
| Input tokens | ~90k (60%+ cached on repeat runs) |
| Output tokens | ~1-2k |
| Reasoning tokens | ~300-500 |

### Convenience shell function

Once installed, add this to `~/.zshrc` (or `~/.bashrc`) to spawn, await,
and print agent responses in one call:

```bash
codex-ask() {
    local prompt="$1"
    local job=$(codex-agent start "$prompt" --map -s read-only -r high 2>&1 \
        | grep -oE 'Job started: [a-f0-9]{8}' | awk '{print $3}')
    [ -z "$job" ] && { echo "spawn failed"; return 1; }
    echo "Job: $job (waiting...)"
    codex-agent await-turn "$job"
    codex-agent output "$job" | python3 -c "
import sys, json
for line in sys.stdin:
    line=line.strip()
    if not line.startswith('{'): continue
    try: e=json.loads(line)
    except: continue
    if e.get('type')=='item.completed' and e.get('item',{}).get('type')=='agent_message':
        print(e['item']['text']); print()
"
}
```

Then:

```bash
codex-ask "list all .ts files under src/ and one-line each"
```

## Commands

| Command | Description |
|---------|-------------|
| `start <prompt>` | Start a new agent with the given prompt |
| `status <id>` | Check job status and details |
| `send <id> <msg>` | Send a message to redirect a running agent (interactive only) |
| `capture <id> [n]` | Get last n lines of output (default: 50) |
| `output <id>` | Get full session output |
| `attach <id>` | Print tmux attach command |
| `watch <id>` | Stream output updates |
| `jobs` | List all jobs |
| `jobs --json` | List jobs with structured metadata (tokens, files, summary) |
| `sessions` | List active tmux sessions |
| `kill <id>` | Terminate a running job (last resort) |
| `clean` | Remove jobs older than 7 days |
| `migrate` | Import JSON jobs into SQLite |
| `verify-storage` | Check JSON/SQLite sync status |
| `health` | Check tmux and codex availability |

## Options

| Option | Description |
|--------|-------------|
| `-r, --reasoning <level>` | Reasoning effort: `low`, `medium`, `high`, `xhigh` |
| `-m, --model <model>` | Model name (default: gpt-5.5) |
| `-w, --wait` | Wait for completion and emit a ping when done |
| `--notify-on-complete <cmd>` | Shell command to run when the job completes |
| `-s, --sandbox <mode>` | `read-only`, `workspace-write`, `danger-full-access` |
| `-f, --file <glob>` | Include files matching glob (repeatable) |
| `-d, --dir <path>` | Working directory |
| `--map` | Include codebase map (docs/CODEBASE_MAP.md) |
| `--strip-ansi` | Remove ANSI control codes and Codex TUI noise from output |
| `--clean` | Alias for `--strip-ansi` |
| `--json` | Output JSON (jobs command only) |
| `--interactive` | Use interactive TUI mode (supports send, idle detection) |
| `--keep-alive` | Disable auto-exit for interactive jobs (multi-turn use) |
| `--no-constraints` | Skip auto-injection of XML constraint blocks |
| `--dry-run` | Preview prompt without executing |

## Jobs JSON Output

Get structured job data with `jobs --json`:

```json
{
  "id": "8abfab85",
  "status": "completed",
  "elapsed_ms": 14897,
  "tokens": {
    "input": 36581,
    "output": 282,
    "context_window": 258400,
    "context_used_pct": 14.16
  },
  "files_modified": ["src/auth.ts", "src/types.ts"],
  "summary": "Implemented the authentication flow..."
}
```

## Examples

### Parallel Investigation

```bash
# Spawn multiple agents to investigate different areas
codex-agent start "Audit authentication flow" -r high --map -s read-only
codex-agent start "Review database queries for N+1 issues" -r high --map -s read-only
codex-agent start "Check for XSS vulnerabilities in templates" -r high --map -s read-only

# Check on all of them
codex-agent jobs --json
```

### Redirecting an Agent (Interactive Mode)

```bash
# Start in interactive mode to enable send
codex-agent start "Investigate auth flow" --map --interactive

# Agent going down wrong path? Redirect it
codex-agent send abc123 "Stop - focus on the auth module instead"

# Agent needs info? Send it
codex-agent send abc123 "The dependency is installed. Continue with typecheck."

# Attach for direct interaction
tmux attach -t codex-agent-abc123
# (Ctrl+B, D to detach)
```

### With File Context

```bash
# Include specific files in the prompt
codex-agent start "Review these files for bugs" -f "src/auth/**/*.ts" -f "src/api/**/*.ts"

# Include codebase map for orientation
codex-agent start "Understand the architecture" --map -r high
```

## How It Works

### Exec Mode (Default — Spawn Runner)

1. You run `codex-agent start "task"`
2. CLI generates a launcher script (`.sh`) and spawns it as a detached child process
3. The launcher pipes your prompt (from file) to `codex exec` via `tee` (for logging)
4. It returns immediately with the job ID
5. Codex works in the background and auto-exits when done
6. Exit code is written to `.exitcode` file — `refreshJobStatus` checks PID + exit code for accurate completion/failure
7. You check with `jobs --json`, `capture`, or `output`

> **Note:** Set `CODEX_AGENT_EXEC_RUNNER=tmux` to use tmux for exec mode (legacy behavior with `attach` support).

### Interactive Mode (`--interactive`)

1. You run `codex-agent start "task" --interactive`
2. CLI generates a launcher script with OS-appropriate `script` invocation (always uses tmux)
3. A detached tmux session starts the Codex TUI
4. Your prompt is sent via `send-keys` (or `load-buffer` for >5000 chars)
5. It returns immediately with the job ID
6. Idle detection monitors for completion (30s grace period → auto `/exit`)
7. You can redirect with `send` if the agent needs course correction

### Storage

Job metadata is stored in SQLite (WAL mode) with dual-write to JSON files for backward compatibility. On first run, existing JSON jobs are automatically backfilled into SQLite.

```
~/.codex-agent/
  codex-agent.db          # SQLite database
  jobs/
    <jobId>.json          # Job metadata (dual-write)
    <jobId>.prompt        # Original prompt
    <jobId>.log           # Terminal output
    <jobId>.sh            # Launcher script
    <jobId>.exitcode      # Exit code (spawn mode)
```

Manage with `codex-agent migrate` (bulk JSON→SQLite) and `codex-agent verify-storage` (sync check). Override storage backend with `CODEX_AGENT_STORAGE=json|sqlite|dual`.

Session output is logged via `tee` (exec) or `script` (interactive). Session metadata is parsed from Codex's JSONL files (`~/.codex/sessions/`) to extract tokens, file modifications, and summaries.

All tmux commands use argv arrays (no shell interpolation). User prompts are read from files, never embedded in commands.

## The Claude Code Plugin

When installed as a Claude Code plugin, the **codex-orchestrator skill** teaches Claude how to use the CLI automatically. Claude becomes the orchestrator:

- Breaks your requests into agent-sized tasks
- Spawns agents with the right flags (read-only for research, workspace-write for implementation)
- Monitors agent progress
- Synthesizes findings from multiple agents
- Course-corrects agents that drift off-task

This means you can just describe what you want, and Claude handles the delegation.

The skill follows a pipeline: **Ideation -> Research -> Synthesis -> PRD -> Implementation -> Review -> Testing**. Each stage uses the appropriate agent configuration.

See [plugins/codex-orchestrator/README.md](plugins/codex-orchestrator/README.md) for full plugin documentation.

## Security

- **No shell injection**: All tmux commands use `spawnSync` with argv arrays — user input never touches shell interpretation
- **Prompt isolation**: Prompts are written to `.prompt` files and read by launcher scripts, never embedded in commands
- **Path boundary enforcement**: File loading validates all resolved paths stay within the working directory
- **Restrictive permissions**: Job directory `0o700`, all files `0o600`, atomic writes prevent torn reads
- **Crash detection**: Failed sessions are distinguished from completed ones via completion marker checks

## Tips

- Use exec mode (default) for most tasks — it auto-completes and is simpler
- Use `--interactive` only when you need mid-task `send` communication
- Use `codex-agent send` to redirect interactive agents — don't kill and respawn
- Use `jobs --json` to get structured data (tokens, files, summary) in one call
- Use `--strip-ansi` (or `--clean`) to get parse-friendly output with ANSI and TUI chrome removed
- Use `-r xhigh` for complex tasks that need deep reasoning
- Use `--map` to give agents codebase context (requires docs/CODEBASE_MAP.md)
- Use `-s read-only` for research tasks that shouldn't modify files
- Kill stuck jobs with `codex-agent kill <id>` only as a last resort
- macOS: pre-trust new project directories in `~/.codex/config.toml` to avoid TUI hangs (see [macOS Notes](#macos-notes))
- macOS: invoke `codex-agent` from Claude Code with `dangerouslyDisableSandbox: true` or add `excludedCommands` to `~/.claude/settings.json` (see [macOS Notes](#macos-notes))
- Parse `agent_message` from the `output` JSON event stream — `status` and `capture` won't show response text directly

## Documentation

- [Usage Guide](docs/usage-guide.md) — Claude Code 使用指南（Skill 模式、手動 CLI、專案階段轉換）
- [Comparison Guide](docs/codex-orchestrator-vs-opus-standalone.md) — 單獨 Opus 4.6 vs Opus + Codex 編隊
- [Codebase Map](docs/CODEBASE_MAP.md) — Architecture, modules, data flows
- [Changelog](CHANGELOG.md) — All changes since fork

## License

MIT
