# Troubleshooting: macOS Sandbox Issues

## Issue 1: Codex CLI Rust Panic (system-configuration)

### Symptom

Codex agents spawned by `codex-agent start` crash immediately with:

```
thread 'main' panicked at system-configuration-0.6.1/src/dynamic_store.rs:154:1:
Attempted to create a NULL object.
```

The agent log shows exit code 0 but no work is done. `codex-agent jobs` reports
COMPLETED status with near-zero elapsed time (10-40s, all spent on startup).

### Root Cause

The Codex CLI is a Rust binary. During HTTP client initialization, it calls the
[`system-configuration`](https://crates.io/crates/system-configuration) crate
(via `reqwest` → `hyper` → DNS resolver) to read macOS network settings.

The call chain:

```
codex exec (Rust)
  → reqwest::Client::new()
    → hyper DNS resolver
      → system_configuration::SCDynamicStoreCreate()
        → Mach port / Unix domain socket to configd
          → BLOCKED by sandbox
            → returns NULL
              → Rust unwrap → panic!
```

`SCDynamicStoreCreate()` connects to the macOS `configd` daemon via a Unix
domain socket (Mach port). When Claude Code's sandbox has
`network.allowAllUnixSockets: false` (default), this connection is blocked,
causing the function to return `NULL`. The Rust crate does not handle the `NULL`
case gracefully — it panics.

### Why `excludedCommands` Alone Doesn't Help

`settings.json` may have:

```json
"excludedCommands": ["codex", "codex-agent"]
```

This only excludes processes directly spawned by Claude Code's Bash tool.
However, `codex-agent` uses **tmux** or **detached spawn** to run agents:

```
Claude Bash tool
  → codex-agent (excluded from sandbox ✅)
    → tmux new-session / child_process.spawn (detached)
      → bash launcher.sh
        → codex exec (NOT excluded ❌, inherits sandbox restrictions)
```

The child process inherits the sandbox environment but does NOT inherit the
`excludedCommands` exemption.

### Fix

In `~/.claude/settings.json`, enable Unix socket access under `sandbox.network`:

```json
{
  "sandbox": {
    "network": {
      "allowAllUnixSockets": true,
      "allowedDomains": [
        "api.openai.com"
      ]
    }
  }
}
```

> **Important**: `allowAllUnixSockets` and `allowedDomains` must be nested
> under `sandbox.network`, not directly under `sandbox`. Placing them at the
> wrong level will silently have no effect.

**A Claude Code session restart is required** after modifying `settings.json`.

---

## Issue 2: `gh` CLI TLS Certificate Verification Failure

### Symptom

Running `gh release create`, `gh pr create`, or any `gh` command that contacts
GitHub API fails with:

```
tls: failed to verify certificate: x509: OSStatus -26276
```

### Root Cause

`gh` is written in Go. Go's TLS stack on macOS uses `com.apple.trustd.agent`
(the system TLS trust service) to verify certificates. Claude Code's sandbox
blocks this Mach service by default.

### Fix

In `~/.claude/settings.json`, add `enableWeakerNetworkIsolation`:

```json
{
  "sandbox": {
    "enableWeakerNetworkIsolation": true
  }
}
```

This allows access to `com.apple.trustd.agent` inside the sandbox. Required
for **all Go-based CLI tools** including `gh`, `gcloud`, `terraform`, etc.

> **Security note**: This slightly reduces sandbox isolation by opening access
> to the trustd service. Acceptable for development environments.

**A Claude Code session restart is required.**

---

## Issue 3: `gh repo set-default` Required

### Symptom

`gh release create` or other repo-specific `gh` commands fail with:

```
X No default remote repository has been set.
please run `gh repo set-default` to select a default remote repository.
```

### Root Cause

When `origin` remote points to a fork (e.g., `yelban/codex-orchestrator`)
while `upstream` points to the original repo (e.g.,
`kingbootoshi/codex-orchestrator`), `gh` doesn't know which repo to target.

Additionally, `gh repo set-default` writes to `.git/config`, which may be
blocked by Claude Code's sandbox.

### Fix

Run `gh repo set-default` **outside** of Claude Code (in a regular terminal):

```bash
gh repo set-default yelban/codex-orchestrator
```

This is a one-time setup per clone. After setting the default, `gh` commands
will work normally from within Claude Code.

If running inside Claude Code fails with `Operation not permitted`, the
sandbox is blocking `.git/config` writes — use a regular terminal instead.

---

## Complete Recommended Settings

Minimal `~/.claude/settings.json` sandbox config for codex-orchestrator + gh:

```json
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": true,
    "excludedCommands": ["codex", "codex-agent"],
    "enableWeakerNetworkIsolation": true,
    "filesystem": {
      "allowWrite": [
        "//tmp",
        "//private/tmp",
        "~/.codex-agent"
      ]
    },
    "network": {
      "allowAllUnixSockets": true,
      "allowedDomains": [
        "api.openai.com",
        "github.com",
        "api.github.com"
      ]
    }
  }
}
```

> **Path prefix reminder**: Use `//` for absolute paths (`//tmp` → `/tmp`),
> `~/` for home-relative paths. A bare `/tmp` is relative to the settings
> file's directory, not the filesystem root.

## Verification

After restarting Claude Code:

```bash
# Test Codex CLI (should complete without panic)
codex-agent start "list files in current directory" --map -s read-only

# Test gh CLI (should complete without TLS error)
gh release list --limit 1
```

## Affected Versions

- **Codex CLI**: 0.115.0+ (any version using `reqwest` with `system-configuration` crate)
- **Platform**: macOS only (Linux is not affected)
- **Claude Code**: Any version with sandbox enabled

## Related

- Rust crate: [`system-configuration`](https://docs.rs/system-configuration/)
- macOS API: `SCDynamicStoreCreate()` in `SystemConfiguration.framework`
- Claude Code sandbox docs: [code.claude.com/docs/en/sandboxing](https://code.claude.com/docs/en/sandboxing)
- Claude Code settings docs: [code.claude.com/docs/en/settings](https://code.claude.com/docs/en/settings)
