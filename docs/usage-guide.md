# Codex Orchestrator 使用指南

## 快速開始

### 1. 環境準備

```bash
codex-agent health    # 確認 tmux + codex 可用
```

若未安裝，執行 `/codex-orchestrator init` 或：

```bash
bash ~/.codex-orchestrator/plugins/codex-orchestrator/scripts/install.sh
codex --login         # 認證 OpenAI
```

### 2. 產生 Codebase Map

進入專案目錄後：

```
/cartographer
```

產出 `docs/CODEBASE_MAP.md`，後續所有 agent 透過 `--map` 即可獲得完整架構理解。
**每次大改動後建議重跑**，確保 map 反映最新程式碼。

## 在 Claude Code 中使用

### 方式一：Skill 自動觸發（推薦）

直接描述任務，skill 自動觸發：

```
幫我實作 P4 的 auth 重構，PRD 在 docs/prds/p4-auth.md
```

或明確呼叫：

```
/codex-orchestrator
```

Claude 會自動接管：解析需求 → 派 agent → 監控進度 → 彙整結果。
不需要手動打 CLI 指令，Claude 會自動加 `--map`。

### 方式二：手動下 CLI 指令

在對話中請 Claude 執行特定指令：

```
請用 codex-agent 跑以下任務：
1. read-only 調查目前 auth 模組的現狀
2. workspace-write 實作 PRD 裡的 Phase 1
兩個平行跑，都要加 --map
```

Claude 會透過 Bash 工具幫你執行 `codex-agent start ...` 指令。

### 兩種方式比較

| | Skill 模式 | 手動 CLI |
|---|---|---|
| 誰決定怎麼拆任務 | Claude 自主判斷 | 你指定 |
| 監控回報 | Claude 自動追蹤 | 你主動要求才查 |
| 適合場景 | 大方向交給 Claude | 你已經知道怎麼拆 |

## 專案階段轉換（以 P3→P4 為例）

### Step 1：更新 Map

P3 完成後程式碼已變動，先更新：

```
/cartographer
```

### Step 2：研究階段 — read-only agent

```bash
# 有 PRD 時
codex-agent start "Read docs/prds/p4-xxx.md and analyze what needs to change. List affected files and potential risks." --map -s read-only

# 沒有 PRD，先調查
codex-agent start "Investigate the current state of [模組]. What's implemented in P3? What's missing for P4?" --map -s read-only
```

### Step 3：實作階段 — workspace-write agent

```bash
# 單一任務（exec 模式，自動完成）
codex-agent start "Implement P4 Phase 1 per docs/prds/p4-xxx.md. Read the PRD first." --map

# 需要多輪對話的複雜任務
codex-agent start "Implement the new API endpoints for P4" --map --interactive

# 平行派多個 agent 處理不同模組
codex-agent start "Implement P4 auth changes per PRD" --map -f "src/auth/**/*.ts"
codex-agent start "Implement P4 database migrations per PRD" --map -f "src/db/**/*.ts"
```

### Step 4：監控與追蹤

```bash
codex-agent jobs --json    # 結構化狀態（token、修改檔案、摘要）
codex-agent capture <id>   # 看最近輸出
codex-agent watch <id>     # 串流輸出
```

### Step 5：審查與測試

```bash
codex-agent start "Security review the P4 changes" --map -s read-only
codex-agent start "Write tests for the P4 auth module and run them" --map
```

## 雙模式選擇

codex-orchestrator 支援兩種執行模式：

| 情境 | 模式 | 指令 |
|------|------|------|
| 明確的單一任務，不需中途追加 | **exec**（預設） | `codex-agent start "..." --map` |
| 可能需要中途 send 追加 prompt | **interactive** | `codex-agent start "..." --map --interactive` |

### Exec 模式（預設）

- 使用 `codex exec`，完成後自動退出
- 不支援 `send` 指令
- 大部分情況用這個就好

### Interactive 模式

- 使用 Codex TUI，支援 `codex-agent send <id> "追加指令"`
- Idle detection 30 秒後自動送 `/exit`
- 適合探索性任務、需要多輪引導的工作
- 用 `--interactive` flag 啟用

```bash
# 啟動 interactive agent
codex-agent start "Analyze the codebase architecture" --map --interactive

# 等 agent 完成第一輪後追加指令
codex-agent send <id> "Now focus on the database layer"

# 用 --keep-alive 停用 idle detection（持續對話）
codex-agent start "Long exploration task" --map --interactive --keep-alive
```

## Sandbox 模式選擇

| 模式 | 用途 | 指令 |
|------|------|------|
| `read-only` | 研究、調查、審查 | `-s read-only` |
| `workspace-write`（預設） | 實作、測試 | 不加 flag |
| `danger-full-access` | 需要系統層級操作 | `-s danger-full-access` |

## 常用組合範例

```bash
# 研究任務（read-only + map）
codex-agent start "Audit auth for OWASP vulnerabilities" --map -s read-only

# 標準實作（workspace-write + map + PRD）
codex-agent start "Implement feature per PRD" --map -f "docs/prds/feature.md"

# 帶檔案 context 的實作
codex-agent start "Refactor this module" --map -f "src/auth/**/*.ts" -f "src/types.ts"

# 預覽 prompt（不執行）
codex-agent start "Test prompt" --map -f "src/**/*.ts" --dry-run

# 查看乾淨輸出（去除 ANSI codes）
codex-agent capture <id> --strip-ansi
codex-agent output <id> --strip-ansi
```

## 多 Claude 實例協作

開多個 Claude Code 視窗，各自指揮 Codex 軍團：

```
Claude #1: 負責 auth 模組重構（3 個 Codex agent）
Claude #2: 負責 API endpoints 實作（2 個 Codex agent）
Claude #3: 負責 security review（4 個 Codex agent）
Claude #4: 負責寫測試（2 個 Codex agent）
```

所有實例共享 `agents.log`，透過 job ID 區分各自的 agent。

## 故障排除

```bash
# Agent 看起來卡住
codex-agent capture <id> 100    # 查看最近輸出
codex-agent send <id> "Status update - what's blocking you?"  # interactive only

# 檢查所有 job 狀態
codex-agent jobs --json

# 真的卡住了（最後手段）
codex-agent kill <id>

# 清理舊 job（超過 7 天）
codex-agent clean
```

## Agent 耗時預期

Codex agent 需要時間，這是正常的：

| 任務類型 | 典型耗時 |
|----------|----------|
| 簡單研究 | 10-20 分鐘 |
| 單一功能實作 | 20-40 分鐘 |
| 複雜實作 | 30-60+ 分鐘 |
| 完整 PRD 實作 | 45-90+ 分鐘 |

不要因為 agent 跑了 20 分鐘就 kill 它 — 它在深入閱讀和仔細實作。
