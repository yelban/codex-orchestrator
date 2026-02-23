# Plan: Multi-Provider Support (OpenAI + Gemini) — Opus 4.6 PRD

**Generated**: 2026-02-23
**Author**: Claude Opus 4.6
**Estimated Complexity**: Medium
**Comparable plan**: `codex-plan.codex.md` (GPT-5.3-Codex)

---

## Problem Statement

`codex-orchestrator` hardcodes OpenAI Codex execution paths. Adding Gemini CLI as a second provider enables three orchestration patterns that Claude (as orchestrator) cannot currently perform: parallel cross-validation of analytical findings, generate-then-review workflows, and specialist routing by provider strength.

The design challenge is adding this capability without pulling a lean CLI toward orchestration-monolith territory (claude-octopus's 17,775-line trap).

## Design Philosophy

### The Framing Problem

The three prior analyses (Gemini, Codex, Sonnet) all evaluate the consensus mechanism *as designed*. The real question is whether "consensus" is even the right product concept.

**codex-orchestrator is a job multiplexer.** It starts jobs, tracks them, returns outputs. Adding `--provider gemini` is a natural extension — it's just another job type. **"Consensus mode" is an orchestration policy** — a decision about *what to do with* multiple outputs. That policy belongs in SKILL.md, not in CLI code.

### The Complexity Creep Test

After Phase 1 ships, if you find yourself wanting to add a single new CLI command or flag for consensus purposes, that's the signal you've crossed the line. Stop and write SKILL.md guidance instead.

## Design Decisions

### 1. CLI is a job multiplexer, not a consensus engine

- **Decision**: Add `--provider openai|gemini` only. No `--provider openai,gemini` multi-dispatch. No `groupId`. No `await-group`. No consensus subcommands.
- **Why I disagree with Codex**: Codex recommended `start --provider openai,gemini` returning `{groupId, jobs[]}`. This couples an orchestration pattern to the CLI interface. If the user later decides adversarial review (sequential) is better than parallel consensus, the multi-dispatch abstraction is wasted. Keep primitives orthogonal.
- **Where this lives**: Claude orchestrates multi-job dispatch via SKILL.md patterns — it already has `start`, `await-turn`, `output` primitives and can simply issue two `start` commands.

### 2. Three collaboration patterns replace "consensus mode"

| Pattern | When | Workflow |
|---------|------|----------|
| **A: Parallel analysis** | Reviewing existing code for bugs/security | Both providers analyze same code; different analytical styles = signal |
| **B: Generate → adversarial review** | Writing new code, refactoring | One generates, other critiques; avoids style-noise of parallel generation |
| **C: Specialist routing** | Context-heavy tasks (50+ files) | Send to whichever provider is better suited; no consensus needed |

### 3. Drop self-reported scoring entirely

- **Decision**: Remove any `Security: X/10` guidance from SKILL.md.
- **Evidence**: Gemini defaults to conservative calibration (its 8/10 ≈ Codex's 10/10). Both collapse to 8–10 without strict OWASP rubric. All four models agreed this is noise.
- **Replacement**: Evidence-based synthesis checklist (see Phase 2).

### 4. Anonymous synthesis to prevent provider-identity bias

- **Decision**: Before synthesis, relabel outputs as "Analysis Alpha" and "Analysis Beta" with randomized assignment. Do NOT reveal which model produced which until AFTER synthesis.

### 5. Gemini defaults (safety-first)

| Setting | Gemini default | Why |
|---------|---------------|-----|
| `--no-constraints` | Auto-enabled | XML `<design_and_scope_constraints>` blocks are Codex-tuned; Gemini may ignore or misinterpret |
| Sandbox | `read-only` | Prevents filesystem races in parallel execution; explicit override required for write |
| Runner | `spawn` only | tmux runner is Codex TUI-specific; Gemini has no TUI |
| Enrichment | `null` | session-parser only handles Codex JSONL format |

### 6. Exit code is authoritative, completion marker is not

- **Decision**: Non-zero exit code = `failed`, regardless of completion marker presence.
- **PIPESTATUS fix**: Use `${PIPESTATUS[0]}` instead of `$?` to capture provider process exit code. Apply to BOTH launchers.

## Out of Scope

- Gemini interactive/TUI mode (tmux)
- Gemini enrichment parsing
- Multi-dispatch CLI commands
- Programmatic quality gates
- `ProviderAdapter` interface
- `watch` command redesign

---

## Phase 1: Multi-Provider CLI Runtime

### Task 1.1: Provider Types and Config Defaults
- **Files**: `src/config.ts`
- Add `Provider` type, config fields: `provider`, `providers`, `geminiDefaultModel`, `geminiHardMaxRuntimeMinutes`

### Task 1.2: CLI Provider Parsing + Gemini Defaults + tmux Fix
- **Files**: `src/cli.ts`
- `--provider` flag, explicitness tracking, Gemini defaults, tmux check bug fix

### Task 1.3: Job Model + Provider Propagation
- **Files**: `src/jobs.ts`
- `provider` on Job/StartJobOptions, fail-fast validation, backward compat

### Task 1.4: Spawn Runner — Gemini Launcher + PIPESTATUS Fix
- **Files**: `src/spawn-runner.ts`
- `buildGeminiLauncher()`, route by provider, PIPESTATUS fix both launchers

### Task 1.5: Exit Code Authoritative + Hard Max Timeout + Skip Enrichment
- **Files**: `src/jobs.ts`
- Fix `refreshSpawnJob()` exit code logic, Gemini hard max, skip non-openai enrichment

### Task 1.6: SQLite Migration v2 → v3
- **Files**: `src/store/sqlite-store.ts`
- Add `provider` column, bump schema version

### Task 1.7: Output Cleaner — Provider-Aware Split
- **Files**: `src/output-cleaner.ts`, `src/cli.ts`
- Gemini cleaner, route by provider, update callers

### Task 1.8: Provider Visibility in CLI Output
- **Files**: `src/cli.ts`, `src/jobs.ts`
- Show provider in jobs table, status, JSON, dry-run

### Task 1.9: Verify JobStore Contract Compatibility
- Type check all store implementations

---

## Phase 2: SKILL.md Multi-Provider Patterns

### Task 2.1: Multi-Provider Patterns A/B/C
- **File**: `plugins/codex-orchestrator/skills/codex-orchestrator/SKILL.md`
- Patterns A (parallel analysis), B (generate→review), C (specialist routing)

### Task 2.2: Synthesis Protocol + Task-Type Guidance
- Anonymous relabeling, 4-step synthesis, sandbox safety rules

---

## Phase 3: Sync and Distribution

### Task 3.1: Push + Sync Plugin Copies

---

## Dependency Graph

Critical path: 1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 3.1
Parallelizable after 1.3: {1.4, 1.6, 1.7, 1.8, 1.9}
Independent: 2.1 → 2.2
