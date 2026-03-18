# Claude Code 安全防護設定指南：Sandbox + Hooks

適用情境：使用 `--dangerously-skip-permissions` 時，限制 Claude 只能操作當前專案目錄，阻擋 `rm`、`sudo` 等危險操作。

---

## 架構總覽

```
┌─────────────────────────────────────┐
│  Layer 1: Permission Deny Rules     │  ← Claude 決策層攔截（Write/Edit 唯一防線）
├─────────────────────────────────────┤
│  Layer 2: PreToolUse Hooks          │  ← 指令 pattern 攔截（bypass mode 仍有效）
├─────────────────────────────────────┤
│  Layer 3: Native Sandbox (srt)      │  ← OS 層級 filesystem/network 隔離
└─────────────────────────────────────┘
```

三層各自獨立，任一層擋住就不會執行。

---

## Step 1：啟用 Sandbox

在 Claude Code session 中輸入 `/sandbox`，選擇 auto-allow 模式。

或直接在 `~/.claude/settings.json` 寫入（全域生效）：

```json
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": false,
    "excludedCommands": [],
    "network": {
      "allowAllUnixSockets": false,
      "allowedDomains": [
        "registry.npmjs.org",
        "pypi.org",
        "files.pythonhosted.org",
        "github.com",
        "api.github.com",
        "objects.githubusercontent.com"
      ]
    },
    "filesystem": {
      "allowWrite": ["//tmp", "//private/tmp", "~/.cache/uv"]
    }
  }
}
```

> **注意**：如果你使用 Codex Orchestrator 或其他需要 Unix socket 的工具，請參考下方「Codex Orchestrator 使用者」段落調整設定。

### 各欄位說明

| 欄位 | 值 | 作用 |
|------|-----|------|
| `enabled` | `true` | 啟用 OS 層級沙箱 |
| `autoAllowBashIfSandboxed` | `true` | sandbox 內的 bash 自動放行，不再逐一詢問 |
| `allowUnsandboxedCommands` | `false` | **關鍵**：sandbox 失敗時不允許跳出重試 |
| `excludedCommands` | `[]` | 不排除任何指令（全部進 sandbox） |
| `network.allowAllUnixSockets` | `false` | 封鎖 Unix socket（防 Docker socket 逃逸） |
| `network.allowedDomains` | 依需求 | bash 可連線的域名白名單（見下方說明） |
| `filesystem.allowWrite` | 見上方 | 額外允許寫入的路徑（工作目錄預設已可寫入） |

### Sandbox 兩層機制釐清

Claude Code sandbox 分為兩個獨立層級：

| 層級 | 機制 | 控制方式 |
|------|------|----------|
| **Claude 權限層** | 決定是否需要使用者確認才能執行 | `permissions.allow/deny`、`excludedCommands` |
| **OS sandbox 層** | 檔案系統/網路/Unix socket 的實際限制 | `filesystem`、`network`、sandbox binary (srt) |

`excludedCommands` **只影響 Claude 權限層**（跳過確認提示），**不影響 OS sandbox 層**。即使指令在 `excludedCommands` 裡，OS 層的檔案系統和網路限制仍然生效。

### filesystem.allowWrite 路徑前綴

根據官方文件，路徑前綴的解析方式：

| 前綴 | 意義 | 範例 |
|------|------|------|
| `//` | 從檔案系統根目錄算起（絕對路徑） | `//tmp/build` → `/tmp/build` |
| `~/` | 相對於家目錄 | `~/.kube` → `$HOME/.kube` |
| `/` | 相對於 settings 檔案所在目錄 | `/build` → `$SETTINGS_DIR/build` |
| `./` 或無前綴 | 相對路徑（由 sandbox runtime 解析） | `./output` |

> **常見錯誤**：寫 `/tmp` 會被解析為相對於 `~/.claude/` 的路徑，不是系統的 `/tmp`。正確寫法是 `//tmp`。

### filesystem.allowWrite 說明

- `//tmp` 和 `//private/tmp`：macOS 上 `/tmp` 是 `/private/tmp` 的 symlink，兩個都加確保不出問題
- `~/.cache/uv`：`uv`（Python 套件管理器）的快取路徑，不開會導致 `uv run` 報 Operation not permitted
- `~/.codex-agent`：codex-agent 的 SQLite 資料庫路徑（僅 Codex Orchestrator 使用者需要）

碰到新的工具報 Operation not permitted 時，依相同方式把它的寫入路徑加進來。

### network 說明

網路隔離是 **deny-by-default** 架構。sandbox-runtime 預設阻擋所有網路存取，只有列在 `network.allowedDomains` 裡的域名才能連線。

- 不支援 `*` 萬用字元全部放行
- 拿掉整個 `allowedDomains` = 空白名單 = 全部阻擋
- 工作中碰到新域名被擋時，sandbox 會觸發提示讓你決定是否放行，同意後自動加入，不需手動改設定檔
- 如有其他需求（Docker Hub、crates.io 等）自行加入

`network.allowAllUnixSockets` 控制是否允許 Unix domain socket 連線。設為 `false` 可防止存取 Docker daemon socket (`/var/run/docker.sock`) 等。但某些工具（如 Codex CLI）需要 Unix socket 才能正常運作，詳見下方說明。

### 平台前置需求

**macOS**：零設定，使用內建 `sandbox-exec`（Seatbelt）。

**Linux**：

```bash
# Debian/Ubuntu
sudo apt install bubblewrap socat

# Fedora
sudo dnf install bubblewrap socat
```

確認 user namespaces 已啟用（多數發行版預設開啟）。

**Docker 內的 Linux**：標準 sandbox 無法運作（缺少 privileged namespaces）。需啟用 `enableWeakerNestedSandbox: true`，但安全性大幅降低，建議改用 Docker 本身做隔離。

---

## Codex Orchestrator 使用者必讀

### 問題：macOS 上 Codex CLI 因 sandbox 而 Rust panic

Codex CLI 是 Rust 二進位檔。初始化 HTTP client 時，它透過 `system-configuration` crate 呼叫 macOS `SCDynamicStoreCreate()` API 讀取 DNS/proxy 設定。這個 API 需要透過 **Unix domain socket** 連接 macOS `configd` daemon。

當 `network.allowAllUnixSockets` 為 `false` 時：

```
codex exec (Rust binary)
  → reqwest::Client::new()
    → system-configuration::SCDynamicStoreCreate()
      → Unix socket to configd ← BLOCKED by sandbox
        → returns NULL → Rust panic!
```

錯誤訊息：

```
thread 'main' panicked at system-configuration-0.6.1/src/dynamic_store.rs:154:1:
Attempted to create a NULL object.
```

### 為什麼 `excludedCommands` 無法解決

你可能會想把 `codex`、`tmux`、`bash` 都加到 `excludedCommands`：

```json
"excludedCommands": ["codex", "codex-agent", "tmux", "bash"]
```

**這不會有用。** 原因：

1. `excludedCommands` 只影響 Claude 權限層（跳過確認），**不繞過 OS sandbox**
2. 即使 `codex` 在列表中，直接跑 `codex exec` 仍會 panic（已實測驗證）
3. `codex-agent` 透過 tmux 產生子行程的路徑更長，但根本原因一樣

實測證明：

```bash
# codex 在 excludedCommands 裡，sandbox 內仍然 panic
echo "hello" | codex exec -m gpt-5.4 -s read-only --json -
# → panic at dynamic_store.rs:154

# 關閉 sandbox 後正常
# (dangerouslyDisableSandbox: true)
echo "hello" | codex exec -m gpt-5.4 -s read-only --json -
# → {"type":"thread.started",...} ✅
```

### 修復：Codex Orchestrator 的 sandbox 設定

```json
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": true,
    "excludedCommands": ["codex", "codex-agent"],
    "network": {
      "allowAllUnixSockets": true,
      "allowedDomains": [
        "registry.npmjs.org",
        "pypi.org",
        "files.pythonhosted.org",
        "github.com",
        "api.github.com",
        "objects.githubusercontent.com",
        "crates.io",
        "static.crates.io",
        "api.openai.com"
      ]
    },
    "filesystem": {
      "allowWrite": ["//tmp", "//private/tmp", "~/.cache/uv", "~/.codex-agent"]
    }
  }
}
```

與純防護設定的差異：

| 欄位 | 純防護 | Codex Orchestrator | 理由 |
|------|--------|---------------------|------|
| `allowUnsandboxedCommands` | `false` | `true` | Codex agent 需要寫入專案目錄 |
| `excludedCommands` | `[]` | `["codex", "codex-agent"]` | 避免每次都要確認 |
| `network.allowAllUnixSockets` | `false` | **`true`** | **macOS configd 需要 Unix socket** |
| `network.allowedDomains` | 基本 | + `api.openai.com`、`crates.io` | Codex API + Rust 依賴 |
| `filesystem.allowWrite` | 基本 | + `~/.codex-agent` | Agent 的 SQLite DB |

> **修改 sandbox 設定後必須重啟 Claude Code session。** Sandbox 設定在 session 啟動時載入，不會即時生效。

### 安全取捨

開啟 `allowAllUnixSockets` 會允許所有 Unix socket 存取，包含 Docker daemon socket。如果你同時在使用 Docker 且擔心 socket 逃逸風險，建議：

- 在不需要 Codex agent 的 session 中維持 `false`
- 或用專案級 `.claude/settings.json` 只在特定專案開啟

---

## Go CLI 工具 TLS 問題（gh、gcloud、terraform）

### 問題：TLS 憑證驗證失敗

Go 語言編寫的 CLI 工具在 sandbox 內執行時，可能遇到 TLS 錯誤：

```
tls: failed to verify certificate: x509: OSStatus -26276
```

### 根因

Go 的 TLS 在 macOS 上使用 `com.apple.trustd.agent`（系統 TLS 信任服務）驗證憑證。Claude Code sandbox 預設阻擋此 Mach 服務。

### 修復

在 `~/.claude/settings.json` 的 `sandbox` 區塊加入：

```json
"enableWeakerNetworkIsolation": true
```

此設定允許存取 `com.apple.trustd.agent`，讓所有 Go 工具正常驗證 TLS 憑證。

> **安全性影響**：稍微降低 sandbox 隔離（開放 trustd 服務存取路徑），對開發環境影響不大。

### 適用工具

| 工具 | 語言 | 需要 `enableWeakerNetworkIsolation` |
|------|------|------|
| `gh` (GitHub CLI) | Go | ✅ |
| `gcloud` | Go | ✅ |
| `terraform` | Go | ✅ |
| `codex` (Codex CLI) | Rust | ❌（需要 `allowAllUnixSockets`） |
| `npm` / `bun` | JS | ❌ |

---

## Fork Repo 的 `gh repo set-default`

### 問題

在 fork repo 中執行 `gh release create`、`gh pr create` 等指令時：

```
X No default remote repository has been set.
please run `gh repo set-default` to select a default remote repository.
```

### 根因

`origin` 指向 fork（如 `yelban/codex-orchestrator`），`upstream` 指向原始 repo（如 `kingbootoshi/codex-orchestrator`），`gh` 無法自動判斷要操作哪個 repo。

### 修復

在**一般終端**（非 Claude Code 內）執行一次：

```bash
gh repo set-default yelban/codex-orchestrator
```

此指令寫入 `.git/config`，可能被 Claude Code sandbox 的 filesystem 限制阻擋，因此需在 sandbox 外執行。設定後 `gh` 指令在 Claude Code 內即可正常運作。

---

## Step 2：設定 Permission Deny Rules

在同一個 `~/.claude/settings.json` 加入 `permissions` 區塊。只擋系統層級的危險操作：

```json
{
  "permissions": {
    "deny": [
      "Bash(sudo:*)",
      "Bash(su:*)",
      "Bash(mkfs:*)",
      "Bash(dd:*)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Edit(~/.bashrc)",
      "Edit(~/.zshrc)"
    ]
  }
}
```

### 與既有 allow 規則的關係

如果你的 `permissions` 已經有 `allow` 區塊，直接加 `deny` 即可，不用刪 `allow`。兩者並存，各管各的。

評估順序：**deny 先檢查 → ask → allow**。First match wins，deny 永遠優先於 allow。同一個 pattern 同時出現在兩邊，deny 贏。

範例：

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run lint)",
      "Bash(npm run test)",
      "Bash(git status)",
      "Bash(git diff:*)"
    ],
    "deny": [
      "Bash(sudo:*)",
      "Bash(su:*)",
      "Bash(mkfs:*)",
      "Bash(dd:*)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Edit(~/.bashrc)",
      "Edit(~/.zshrc)"
    ]
  }
}
```

> deny 規則在 `bypassPermissions` 模式下仍然生效，且是攔截 Write/Edit 工具的唯一機制（這兩個工具不受 sandbox OS 層管控）。

---

## Step 3：建立 PreToolUse Hooks

Hooks 在 bypass mode 下仍會觸發。

### 3.1 Hook 資料傳入方式

**重要**：Hook 接收事件資料的方式是 **stdin（標準輸入）**，不是環境變數。沒有 `$CLAUDE_TOOL_INPUT` 這個環境變數。

stdin 傳入的 JSON 結構：

```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {
    "command": "rm -rf /some/directory"
  },
  "session_id": "abc123...",
  "transcript_path": "/path/to/transcript",
  "cwd": "/home/user/project",
  "permission_mode": "default"
}
```

讀取方式：

```bash
INPUT=$(cat)                                          # 從 stdin 讀取整個 JSON
CMD=$(echo "$INPUT" | jq -r '.tool_input.command')    # 取出指令
```

### 3.2 建立 hooks 目錄

```bash
mkdir -p ~/.claude/hooks
mkdir -p ~/.claude/logs
```

### 3.3 擋危險 rm 操作

`~/.claude/hooks/block-dangerous-rm.sh`：

只擋遞迴刪除（`rm -r` / `rm -rf`），單檔 `rm` 交給 sandbox OS 層管控。這樣不需要逐一維護外部路徑白名單。

```bash
#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.bun/bin:$HOME/.deno/bin:$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.nvm/versions/node/v22.21.1/bin:$HOME/.orbstack/bin:$PATH"

# 從 stdin 讀取 JSON
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && exit 0

# 只擋遞迴刪除（rm -r / rm -rf / rm -fr），且不在 /tmp 下
if echo "$CMD" | grep -qE '\brm\s+[^|;]*-(r|rf|fr|Rf|fR)\b'; then
  if echo "$CMD" | grep -qE '\brm\s+[^|;]*-(r|rf|fr|Rf|fR)\s+/tmp/'; then
    exit 0
  fi
  echo "BLOCKED: 禁止使用 rm -rf / rm -r，請改用 trash 或逐一刪除" >&2
  exit 2
fi

exit 0
```

設計邏輯：

- `rm -rf /tmp/xxx`：放行（暫存目錄）
- `rm -rf ~/anything`：阻擋（遞迴刪除）
- `rm -rf ./node_modules`：阻擋（專案內也擋遞迴刪除，用 trash 更安全）
- `rm some-file.txt`：放行（單檔刪除交給 sandbox 管寫入範圍）

### 3.4 Bash 指令審計 log（選配但推薦）

`~/.claude/hooks/audit-log.sh`：

```bash
#!/usr/bin/env bash
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.bun/bin:$HOME/.deno/bin:$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.nvm/versions/node/v22.21.1/bin:$HOME/.orbstack/bin:$PATH"

# 確保目錄存在
mkdir -p "${HOME}/.claude/logs"

# 從 stdin 讀取 JSON
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0

echo "[$(date -Iseconds)] [$(pwd)] $CMD" >> "${HOME}/.claude/logs/bash-audit.log"

exit 0
```

### 3.5 設定執行權限

```bash
chmod +x ~/.claude/hooks/block-dangerous-rm.sh
chmod +x ~/.claude/hooks/audit-log.sh
```

### 3.6 PATH 說明

Hook 在 sandbox 內執行時，PATH 可能不包含使用者安裝的工具路徑，導致 `jq` 等指令找不到。上面兩個 hook 開頭的 `export PATH` 涵蓋了常見路徑：

| 路徑 | 工具 |
|------|------|
| `/opt/homebrew/bin` `/opt/homebrew/sbin` | Homebrew（jq、ffmpeg 等） |
| `/usr/local/bin` | 舊版 Homebrew / 手動安裝 |
| `$HOME/.bun/bin` | Bun |
| `$HOME/.deno/bin` | Deno |
| `$HOME/.cargo/bin` | Rust / Cargo |
| `$HOME/.local/bin` | pipx / uv 安裝的 CLI |
| `$HOME/.nvm/versions/node/v22.21.1/bin` | nvm 管理的 Node.js |
| `$HOME/.orbstack/bin` | OrbStack |

> nvm 路徑包含硬編碼版本號，切換 Node 版本時記得同步更新。

### 3.7 在 settings.json 註冊 hooks

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/block-dangerous-rm.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/audit-log.sh"
          }
        ]
      }
    ]
  }
}
```

### Hook 退出碼

| 退出碼 | 行為 |
|--------|------|
| `exit 0` | 放行 |
| `exit 2` | 阻擋，stderr 訊息回傳給 Claude |
| `exit 1` | 靜默失敗，不阻擋 |

---

## 完整 ~/.claude/settings.json（實際使用版）

以下是目前實際運行的完整設定，包含 Codex Orchestrator、plugins、statusLine 等：

```json
{
  "env": {
    "ENABLE_LSP_TOOL": "1"
  },
  "permissions": {
    "allow": [
      "Bash(tail *)",
      "Bash(head *)",
      "Bash(cat *)",
      "Bash(ls *)",
      "Bash(find *)",
      "Bash(du *)",
      "Bash(wc *)",
      "Bash(stat *)",
      "Bash(ps *)",
      "Bash(date*)",
      "Bash(pgrep *)",
      "Bash(grep *)",
      "Bash(sleep *)",
      "Bash(source *)",
      "Bash(cd *)",
      "Bash(cp *)",
      "Bash(mkdir *)",
      "Bash(chmod *)",
      "Bash(uv *)",
      "Bash(python *)",
      "Bash(python3 *)",
      "Bash(./scripts/build*)",
      "Bash(./scripts/flash*)",
      "Bash(idf.py *)",
      "Bash(rm -rf build *)",
      "Bash(rm -rf build sdkconfig*)"
    ],
    "deny": [
      "Bash(sudo:*)",
      "Bash(su:*)",
      "Bash(mkfs:*)",
      "Bash(dd:*)",
      "Read(~/.aws/**)",
      "Edit(~/.bashrc)",
      "Edit(~/.zshrc)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/block-dangerous-rm.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/audit-log.sh"
          }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "/Users/orz99/.claude/statusline-command.sh"
  },
  "enabledPlugins": {
    "document-skills@anthropic-agent-skills": true,
    "vue-volar@claude-code-lsps": true,
    "basedpyright@claude-code-lsps": true,
    "clangd@claude-code-lsps": true,
    "gopls@claude-code-lsps": true,
    "pyright@claude-code-lsps": true,
    "rust-analyzer@claude-code-lsps": true,
    "solidity-language-server@claude-code-lsps": true,
    "vscode-langservers@claude-code-lsps": true,
    "vtsls@claude-code-lsps": true,
    "cartographer@cartographer-marketplace": true,
    "codex-orchestrator@codex-orchestrator-marketplace": true
  },
  "extraKnownMarketplaces": {
    "anthropic-agent-skills": {
      "source": {
        "source": "github",
        "repo": "anthropics/skills"
      }
    },
    "claude-code-lsps": {
      "source": {
        "source": "github",
        "repo": "Piebald-AI/claude-code-lsps"
      }
    },
    "cartographer-marketplace": {
      "source": {
        "source": "github",
        "repo": "yelban/cartographer"
      }
    },
    "codex-orchestrator-marketplace": {
      "source": {
        "source": "github",
        "repo": "yelban/codex-orchestrator"
      }
    }
  },
  "language": "zh-TW",
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": true,
    "filesystem": {
      "allowWrite": [
        "//tmp",
        "//private/tmp",
        "~/.cache/uv",
        "~/.codex-agent"
      ]
    },
    "excludedCommands": ["codex", "codex-agent"],
    "enableWeakerNetworkIsolation": true,
    "network": {
      "allowAllUnixSockets": true,
      "allowedDomains": [
        "registry.npmjs.org",
        "pypi.org",
        "files.pythonhosted.org",
        "github.com",
        "api.github.com",
        "objects.githubusercontent.com",
        "crates.io",
        "static.crates.io",
        "api.openai.com"
      ]
    }
  },
  "effortLevel": "high",
  "promptSuggestionEnabled": false,
  "skipDangerousModePermissionPrompt": true
}
```

### 各區塊說明

| 區塊 | 用途 |
|------|------|
| `env` | 環境變數（如啟用 LSP 工具） |
| `permissions.allow` | 自動放行的 bash 指令（不需確認） |
| `permissions.deny` | 永久禁止的操作（bypass mode 下仍生效） |
| `hooks` | PreToolUse/PostToolUse 腳本（擋 rm -rf + 審計 log） |
| `statusLine` | 底部狀態列自訂腳本 |
| `enabledPlugins` | 已啟用的插件（LSP、cartographer、codex-orchestrator 等） |
| `extraKnownMarketplaces` | 插件市場來源（GitHub repo） |
| `sandbox` | OS 層級沙箱設定（詳見上方說明） |

> `permissions.allow` 區塊請依你實際需求調整。上方是 ESP-IDF 嵌入式開發 + Python/uv 的設定範例。

---

## 檔案清單

設定完成後，你的 `~/.claude/` 目錄結構：

```
~/.claude/
├── settings.json                    ← 主設定檔
├── hooks/
│   ├── block-dangerous-rm.sh        ← PreToolUse hook（只擋遞迴刪除）
│   └── audit-log.sh                 ← PostToolUse hook
└── logs/
    └── bash-audit.log               ← 自動產生的審計紀錄
```

---

## 已知限制

1. **Write/Edit 工具不受 sandbox filesystem 限制**：bypassPermissions 模式下，Write 和 Edit 走 in-process 的 `fs.writeFileSync`，不經過 bubblewrap/seatbelt。Permission deny rules 是唯一能攔它們的機制。

2. **Hook 是 regex pattern matching**：只能擋已知 pattern，無法窮舉。例如 `find . -exec rm {} \;` 這種間接刪除不一定被 hook 抓到。Sandbox 的 OS 層限制才是兜底。

3. **`allowUnsandboxedCommands: false` 可能影響部分工具**：`docker`、`gh` 等指令不相容 sandbox，設 false 會直接失敗。有需要就加到 `excludedCommands` 裡。

4. **Go 工具（`gh`、`gcloud`、`terraform`）TLS 驗證失敗**：Go 的 TLS 使用 `com.apple.trustd.agent` 驗證憑證，sandbox 預設阻擋。需加 `enableWeakerNetworkIsolation: true`（見「Go CLI 工具 TLS 問題」段落）。

5. **`gh` 在 fork repo 需要 `gh repo set-default`**：當 `origin` 指向 fork、`upstream` 指向原始 repo 時，`gh` 不知道操作哪個 repo。需在終端（非 Claude Code 內）執行 `gh repo set-default <owner/repo>`，因為此指令會寫入 `.git/config`，可能被 sandbox 阻擋。

4. **network.allowedDomains 是 deny-by-default**：拿掉整個欄位等於空白名單，所有網路存取都會被擋。不支援 `*` 全放行。

5. **nvm 路徑硬編碼**：hook 裡的 `$HOME/.nvm/versions/node/v22.21.1/bin` 包含版本號，切換 Node 版本時需同步更新 hook。

6. **Hook 資料走 stdin**：不存在 `$CLAUDE_TOOL_INPUT` 環境變數，必須用 `cat` 從 stdin 讀取 JSON，欄位路徑是 `.tool_input.command`。

7. **allowWrite 需依工具擴充**：碰到新工具報 Operation not permitted 時，檢查它的寫入路徑並加入 `filesystem.allowWrite`。

8. **`excludedCommands` 不繞過 OS sandbox**：這個設定只影響 Claude 的權限確認提示。OS 層的檔案系統、網路、Unix socket 限制對所有指令一律生效，不論是否在 `excludedCommands` 中。把 `tmux`、`bash`、`codex` 加進去都不會改變 OS sandbox 的行為。

9. **macOS 上 `allowAllUnixSockets: false` 會導致 Codex CLI panic**：Codex CLI (Rust) 使用 `system-configuration` crate 透過 Unix socket 連接 macOS `configd`。被 sandbox 封鎖後，`SCDynamicStoreCreate()` 返回 NULL，Rust 的 unwrap 直接 panic。此問題僅影響 macOS，Linux 不受影響。

10. **Sandbox 設定修改需重啟 session**：`settings.json` 中的 sandbox 設定在 Claude Code session 啟動時載入，修改後必須重啟 session 才生效。

---

## 驗證設定

啟動 Claude Code 後測試：

```
> 請執行 rm -rf /tmp/test-dir
# 預期：放行（/tmp 白名單）

> 請執行 rm -rf ~/Documents
# 預期：被 hook 擋住，顯示 BLOCKED 訊息

> 請刪除 some-file.txt
# 預期：放行（單檔刪除交給 sandbox 管）

> 請讀取 ~/.ssh/id_rsa
# 預期：被 permission deny 擋住

> 請在 /etc 下建立檔案
# 預期：被 sandbox filesystem 擋住

> 請執行 curl https://example.com
# 預期：被 sandbox network 擋住（不在 allowedDomains）
```

Codex Orchestrator 使用者額外驗證：

```bash
# 確認 codex exec 不再 panic
echo "echo hello" | codex exec -m gpt-5.4 -s read-only --json -
# 預期：正常輸出 JSON

# 確認 codex-agent 可正常運作
codex-agent start "list files in current directory" --map -s read-only
# 預期：正常啟動 agent
```

檢查審計 log 是否正常寫入：

```bash
tail -f ~/.claude/logs/bash-audit.log
```

手動測試 hook（模擬 Claude 傳入的 stdin）：

```bash
# 測試遞迴刪除阻擋
echo '{"tool_input":{"command":"rm -rf ~/Documents"}}' | bash ~/.claude/hooks/block-dangerous-rm.sh
# 預期：stderr 輸出 BLOCKED，exit code 2

# 測試 /tmp 放行
echo '{"tool_input":{"command":"rm -rf /tmp/test"}}' | bash ~/.claude/hooks/block-dangerous-rm.sh
# 預期：靜默放行，exit code 0

# 測試單檔刪除放行
echo '{"tool_input":{"command":"rm some-file.txt"}}' | bash ~/.claude/hooks/block-dangerous-rm.sh
# 預期：靜默放行，exit code 0

# 測試審計 log
echo '{"tool_input":{"command":"echo hello"}}' | bash ~/.claude/hooks/audit-log.sh
tail -1 ~/.claude/logs/bash-audit.log
# 預期：最後一行顯示 echo hello
```

---

## 建議工作流程

```bash
# 1. 確認在專案目錄，git 狀態乾淨
cd ~/projects/my-project
git status

# 2. 開新 branch
git checkout -b claude/feature-xxx

# 3. 啟動 Claude Code
claude --dangerously-skip-permissions "你的任務描述"

# 4. 完成後 review
git diff
git log --oneline

# 5. 不滿意就 reset
git reset --hard HEAD
```

三道防線（sandbox + hook + deny）加上 git 做第四道復原機制。修改 sandbox 設定需重啟 Claude Code session 才生效。