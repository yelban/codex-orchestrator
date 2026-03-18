# Codex Orchestrator 開發使用指南

## 這是什麼？

Codex Orchestrator 讓你用 Claude Code 指揮 OpenAI Codex 和 Gemini agent 軍團完成複雜的開發任務。

**效果**：原本你自己要花數小時的工作（讀 code、規劃、實作、review），交給 agent 平行執行，你只需要做高階決策。一個下午能完成的工作量，用這套系統可以在早上就完成。

### 三層結構

```
你（指揮官）── 提需求、確認方向、做決策
      ↓
  Claude（將軍）── 分析需求、拆任務、派 agent、彙整結果
      ↓
Codex / Gemini Agent（士兵）── 讀程式碼、實作、測試、審查
```

**你不需要手動打 `codex-agent` 指令**。你只需要跟 Claude 說要做什麼，其餘全部自動化。

---

## 環境初始化（首次使用）

### 為什麼需要初始化？

Agent 需要 Bun（執行環境）和 Codex CLI（OpenAI 引擎）。tmux 只在 interactive 模式需要。Gemini CLI 為可選依賴（使用 `--provider gemini` 時需要）。

### 步驟

```
/codex-orchestrator init
```

這個指令會自動：
- 檢查 Bun、Codex CLI 是否存在（tmux 僅 interactive 模式需要）
- 安裝缺少的依賴
- 把 `codex-agent` 加到 PATH
- 跑 health check 確認一切就緒

**可選**：安裝 Gemini CLI 以使用多模型功能：
```bash
npm install -g @anthropic-ai/gemini-cli  # 或依 Gemini CLI 官方安裝指南
```

### 驗證

```bash
codex-agent health
# 應看到：tmux: OK / codex: OK / Status: Ready
```

**初始化只需要做一次**。之後每次開 Claude Code 都直接可用。

### macOS Sandbox 設定（必要）

如果 Claude Code 啟用了 sandbox，**必須**在 `~/.claude/settings.json` 中設定：

```json
"sandbox": {
  "excludedCommands": ["codex", "codex-agent"],
  "network": {
    "allowAllUnixSockets": true,
    "allowedDomains": ["api.openai.com"]
  },
  "filesystem": {
    "allowWrite": ["~/.codex-agent"]
  }
}
```

**`network.allowAllUnixSockets: true` 是強制需求**。Codex CLI (Rust) 在 macOS 上初始化
HTTP client 時需透過 Unix socket 連接 `configd` 讀取 DNS 設定。若為 `false`，
codex 會直接 panic。修改後需重啟 Claude Code session。

詳見 [troubleshooting-macos-sandbox-panic.md](troubleshooting-macos-sandbox-panic.md)。

---

## 新專案啟動（每個新專案第一次）

### 為什麼要建 Codebase Map？

沒有 map 的 agent 像瞎子摸象：它要自己探索 100+ 個檔案才能理解架構，浪費 10-20 分鐘在「看地圖」而不是「做事」。

有 map 的 agent 開局就知道：哪個模組在哪、資料怎麼流、命名慣例是什麼。直接開工。

### 步驟

```
/cartographer
```

**耗時**：5-15 分鐘（依專案大小）

**產出**：`docs/CODEBASE_MAP.md`，包含：
- 所有檔案的用途說明
- 模組邊界和依賴關係
- 資料流
- 命名慣例

**預期效果**：後續每個 agent 耗時約減少 15-25 分鐘，因為不用自己探索架構。

### 何時需要重建 Map？

- 大規模重構後（模組結構改變）
- 新增主要功能模組後
- 定期維護（每週一次）

```
/cartographer    # 重跑會自動 diff，只更新有變動的部分
```

---

## 日常開發流程

### 核心概念：你只需要說需求

```
你：幫我加 rate limiting 到所有 API endpoint
```

Claude 自動：
1. 判斷任務規模（是否需要 PRD）
2. 派研究 agent 了解現有架構
3. 提出方案給你確認
4. 派實作 agent 執行
5. 派 review agent 審查
6. 回報結果

### 任務規模對應策略

| 規模 | 判斷標準 | Claude 的做法 |
|------|----------|---------------|
| 微小 | < 50 行、單一檔案、明確改法 | Claude 直接動手，不派 agent |
| 中型 | 多檔案、單一功能 | 1-2 個 agent 直接實作 |
| 大型 | 跨模組、架構影響 | 研究 → PRD → 分 phase 實作 |
| 超大 | 重構整個系統 | 多個 Claude 視窗各帶 agent 軍團 |

---

## 場景範例

### 場景 1：調查現有程式碼

**情境**：你想知道 cache 的現狀，再決定要不要改

**你說：**
```
幫我調查目前整個專案的 cache 實作，有哪些地方用到、用了什麼方式、有什麼問題？
```

**Claude 的做法：**
- 派 read-only agent（不能改檔案，只能讀），帶 `--map` 開局知道架構
- 指示 agent 搜尋所有 cache 相關的程式碼
- 等 agent 完成（約 10-20 分鐘）
- 彙整調查結果回報

**你會收到類似：**
```
調查結果：
- 發現 3 種不同的 cache 實作：Redis（auth）、記憶體（session）、無 cache（user）
- /api/users/:id 沒有 cache，每次查 DB，高頻端點有效能風險
- cache TTL 設定散落在 5 個檔案，設定不一致（30s 到 5min 不等）
- 建議：統一使用 Redis，集中 TTL 設定

要我寫一個重構 PRD 嗎？
```

**預期效果**：你用 15 分鐘（等待時間）就完成了本來要花 1-2 小時自己讀 code 的調查工作。

---

### 場景 2：實作新功能（有 PRD）

**情境**：你已經有規劃好的 PRD，要開始做

**你說：**
```
幫我實作 docs/prds/rate-limiting.md 的 Phase 1
```

**Claude 的做法：**
1. 派 agent 讀 PRD 全文 + 所有 PRD 列出的相關檔案
2. agent 按 PRD 規格實作 Phase 1
3. agent 自己跑 typecheck 確認沒有 TypeScript 錯誤
4. 完成後回報修改的檔案清單和摘要

**你會收到類似：**
```
Phase 1 完成。

修改的檔案：
- src/middleware/rate-limit.ts（新增）
- src/app.ts（注入 middleware）
- src/config.ts（加入 rate limit 設定）

agent 自行驗證：
- TypeScript 編譯通過
- 現有測試全部通過
- 測試了 /api/users 和 /api/posts 的 rate limit 觸發

要繼續做 Phase 2 嗎？
```

**預期效果**：你確認 PRD 後就能去做別的事，30-40 分鐘後回來看結果。

---

### 場景 3：實作新功能（無 PRD，需要規劃）

**情境**：你有想法但還沒有詳細規劃

**你說：**
```
我想加 webhook 功能，讓用戶可以訂閱事件通知
```

**Claude 的做法：**
1. 派 agent 調查現有的事件系統和 API 結構
2. 根據調查結果，提出實作方案給你討論
3. 你確認方向後，寫 PRD 到 `docs/prds/webhook.md`
4. 你說「PRD OK」→ 開始實作

**為什麼要先寫 PRD？**

大型任務一定先寫 PRD 讓你確認，原因：
- agent 實作過程不會問你問題（全自動），方向錯了跑完才知道
- PRD 逼迫你在實作前把細節想清楚（API 格式、資料庫 schema、邊界條件）
- PRD 是給 agent 的精確規格，減少 agent 自由發揮的空間

**預期效果**：避免「agent 跑了 40 分鐘，但實作方向跟你想的不一樣」的浪費。

---

### 場景 4：平行處理多個獨立任務

**情境**：你有多個互不依賴的任務要做

**你說：**
```
我有三個獨立任務要做：
1. 重構 auth 模組（PRD 在 docs/prds/auth.md）
2. 加 export CSV 功能到 /api/reports
3. 安全性掃描整個 API layer

三個同時跑
```

**Claude 的做法：**
- 同時派 3 個 agent（平行執行）
- 分別等待各 agent 完成
- 各自完成後獨立回報

**預期效果**：3 個任務的總等待時間等於最慢那個 agent 的時間，而不是三個加總。如果每個各要 30 分鐘，你只需要等 30 分鐘，不是 90 分鐘。

---

### 場景 5：Code Review + 修正

**情境**：實作完成後要做安全性和品質審查

**你說：**
```
幫我 review 剛才 auth 重構的改動，特別注意安全性漏洞
```

**Claude 的做法：**
1. 派多個 read-only review agent：
   - 安全性 agent（OWASP Top 10）
   - 錯誤處理 agent
   - 資料完整性 agent
2. 彙整結果，分類為 Critical / Important / Minor
3. Critical 問題：自動再派 agent 修正
4. 修正後，再派 verification agent 確認修正有效

**你會收到類似：**
```
Review 結果：

Critical（已自動修正）：
- auth/session.ts:45 — expired token 未被拒絕，修正完成

Important（建議處理）：
- auth/jwt.ts:23 — secret 從 env 讀取但未驗證格式
- middleware/auth.ts:67 — error message 洩漏太多實作細節

Minor（記錄備用）：
- 3 個檔案的 console.log 應改為 structured logging
```

**預期效果**：自動化安全審查，Critical 問題當場修正，不用等你手動改。

---

### 場景 6：多 Claude 視窗協作（大型專案）

**情境**：要同時推進多個大型功能

**做法：**
開多個 Claude Code 視窗（同一個 terminal 不同 tab 或不同視窗），每個視窗各自負責一塊：

```
視窗 1：你：幫我做 user auth 系統重構
視窗 2：你：幫我做 payment 模組的 v2 API
視窗 3：你：幫我做整個前端的 dark mode
視窗 4：你：幫我寫 e2e 測試套件
```

每個 Claude 各自指揮自己的 Codex agent，完全平行。

**查看所有 agent 狀態：**
```bash
codex-agent jobs
```

所有視窗的 agent 都會出現，用 job ID 區分。

**預期效果**：4 個大型任務平行進行，效率是循序做的 4 倍。

---

### 場景 7：跨模型 Review（Multi-Provider）

**情境**：重要的安全性改動，你想要不同模型從不同角度交叉驗證

**你說：**
```
幫我用 Codex 和 Gemini 兩個模型同時 review auth 模組，然後彙整兩邊的發現
```

**Claude 的做法：**
1. 派 OpenAI Codex agent（`--provider openai -s read-only`）分析 auth 模組
2. 同時派 Gemini agent（`--provider gemini`，預設 read-only）做同樣的分析
3. 等兩邊都完成
4. 匿名彙整（不透露哪個模型產出哪份分析），交叉比對發現

**你會收到類似：**
```
雙模型 review 完成。

兩者都發現的問題：
- session.ts:45 expired token 未被拒絕

Alpha 獨有發現（已驗證）：
- jwt.ts:23 secret 格式未驗證

Beta 獨有發現（已驗證）：
- middleware/auth.ts:67 error 洩漏實作細節

矛盾之處：無
```

**預期效果**：兩個模型的分析盲點不同，交叉驗證能找到單一模型遺漏的問題。

**三種跨模型模式：**

| 模式 | 適用場景 | 做法 |
|------|----------|------|
| **A：平行分析** | 審查既有程式碼（安全、架構） | 兩個 provider 同時分析，比較結果 |
| **B：生成→對抗審查** | 寫新程式碼、重構 | Codex 生成 → Gemini 審查（或反過來） |
| **C：專家路由** | 大量檔案、跨服務分析 | 直接送給 Gemini（context 窗口優勢） |

---

### 場景 8：Gemini 專家路由

**情境**：需要分析大量檔案，Gemini 的大 context 窗口更適合

**你說：**
```
用 Gemini 分析整個 services/ 目錄的依賴關係
```

**Claude 的做法：**
- 派 Gemini agent（`--provider gemini --map -s read-only`）
- Gemini 一次讀入大量檔案，輸出完整分析

**預期效果**：大 context 任務直接送給最適合的模型，不需要跨模型共識。

---

## 工作流建議

### 標準開發循環

```
1. 早上：把今天要做的任務跟 Claude 說
         ↓
2. Claude 派 agent 開始跑
         ↓
3. 你去做別的事（開會、設計、寫文件）
         ↓
4. Agent 完成 → Claude 通知你
         ↓
5. 你確認結果 → 說下一步
         ↓
6. 重複
```

### PRD 寫作建議

對於 Important 以上的任務，先在 `docs/prds/` 建立 PRD：

```markdown
# 功能名稱

## 問題
[什麼問題需要解決]

## 解法
[高層次的方案]

## 需求
- [具體需求 1]
- [具體需求 2]

## 實作計畫
### Phase 1：[名稱]
- [ ] 任務 1
- [ ] 任務 2

## 要修改的檔案
- src/auth/session.ts — [做什麼改動]

## 驗收條件
- [怎麼確認做完了]
```

### 何時介入 agent

| 情況 | 你要做什麼 |
|------|----------|
| Agent 完成，結果正確 | 說「繼續做 Phase 2」或「開始 review」 |
| Agent 完成，方向有偏差 | 說明哪裡不對，請 Claude 重新派 agent |
| Agent 跑超過預期時間 | 請 Claude 看 agent 最近輸出 |
| Agent 真的卡住 | 請 Claude 砍掉再重派，這次提示更明確 |

---

## Agent 耗時預期

| 任務類型 | 典型耗時 |
|----------|----------|
| 簡單研究（找問題、列清單） | 5–15 分鐘 |
| 單一功能實作 | 20–40 分鐘 |
| 複雜實作（跨多模組） | 30–60 分鐘 |
| 完整 PRD 實作 | 45–90+ 分鐘 |

**Agent 慢 ≠ 卡住**。它在深入讀程式碼、思考邊界條件、實作後驗證。這個深度是它品質的來源。

---

## 常見問題

**Q：沒有 Codebase Map 也能用嗎？**

可以。沒有 map 的 agent 會自己探索架構，只是要多花 10-20 分鐘。建議還是先建 map。

**Q：一次可以派幾個 agent？**

理論上無上限。實際上受 OpenAI API rate limit 影響，同時跑 3-6 個是常見範圍。

**Q：Agent 改壞了程式碼怎麼辦？**

用 git 還原。所有 agent 的改動都在 git working tree，`git checkout .` 就能回到原點。這也是為什麼要「分 phase 實作」而不是一次做完——每個 phase 完成後確認沒問題再繼續。

**Q：什麼是 Multi-Provider？什麼時候該用？**

Multi-Provider 讓你用不同的 AI 模型（OpenAI Codex、Gemini）處理同一個任務或不同任務。三種使用模式：

| 模式 | 用途 | 適合場景 |
|------|------|----------|
| 平行分析 | 兩個模型同時分析同一段程式碼 | 安全審查、架構 review |
| 生成→審查 | 一個生成、另一個對抗性審查 | 程式碼生成、重構 |
| 專家路由 | 直接送給最適合的模型 | 大量檔案分析（Gemini context 大） |

**不需要用 multi-provider 的場景**：常見模式的程式碼（JWT、bcrypt）、模糊需求、瑣碎任務、主觀偏好（命名風格）。

**Q：Gemini agent 的預設行為是什麼？**

使用 `--provider gemini` 時，自動套用：
- Sandbox：`read-only`（防止並行執行時的檔案衝突）
- Model：`gemini-3.1-pro-preview`
- Constraints：自動停用（XML constraint blocks 是 Codex 專用格式）
- 不支援 interactive 模式和 tmux runner
- 無 enrichment（tokens、files_modified、summary 為 null）

這些預設可用 `-s`、`-m`、`--no-constraints` 明確覆蓋。

**Q：exec 和 interactive 模式差在哪？**

| 模式 | 用途 | 使用時機 |
|------|------|----------|
| exec（預設）| 自動完成後退出 | 任務明確，不需要中途引導 |
| interactive | 支援追加指令 | 探索性任務、需要多輪對話 |

95% 的情況用 exec 就好。

---

## 三 Skill 組合 vs 單獨使用 Claude Opus 4.6

### 工具角色

| 工具 | 模型 | 角色 |
|------|------|------|
| Claude Code（你的對話）| Claude Opus 4.6 | 策略判斷、需求分析、拆解任務、彙整結果 |
| `/cartographer` | Claude Opus 4.6（subagent）| 掃描 codebase，產出持久化架構地圖 |
| `/codex-plan` | **Codex 5.3 xhigh** | 深讀程式碼後，從 coding 視角產出實作計畫 |
| `/codex-orchestrator` | **Codex 5.3 xhigh** + **Gemini 3.1 Pro**（複數 agent）| 平行執行：實作、測試、review、跨模型分析 |

### 完整三 Skill 流水線

```
/cartographer            → docs/CODEBASE_MAP.md（架構地圖，持久化）
      ↓
/codex-plan              → Claude Opus 問需求 → 找相關檔案
                           → Codex 5.3 xhigh 深讀 → codex-plan.md
      ↓
/codex-orchestrator      → Claude Opus 拿計畫派多個 Codex agent
                           → 平行實作各 phase → 彙整回報
```

---

### 比較分析

#### 執行模型差異

| | Claude Opus 4.6 單獨 | 三 Skill 組合 |
|--|--|--|
| **規劃者** | Opus 4.6（推理強，但 coding 不是專長） | Claude Opus 問需求 + **Codex 5.3 xhigh 深讀程式碼後規劃**（規劃者和執行者同模型） |
| **執行者** | Opus 4.6 循序實作 | **Codex 5.3**（複數 agent，可平行） |
| **平行能力** | 不行，循序 | 多 agent 平行，多視窗再乘上去 |
| **架構記憶** | 對話 context 內（關掉就沒了） | 持久化 `docs/CODEBASE_MAP.md`（跨 session 有效） |
| **每任務 context** | 共用同一個對話視窗，越做越擁擠 | 每個 agent 各自獨立 context，互不干擾 |
| **計畫品質** | Opus 推理計畫（通用型） | Codex 5.3 讀完實際程式碼後的計畫（貼近程式碼） |

---

#### Claude Opus 4.6 單獨

**優點**
- 即時反應，30 秒內就能動手
- 邊做邊討論，即時調整方向
- 小任務成本低，不需要等 agent 啟動
- Opus 4.6 推理能力強，複雜判斷交給它很合適

**缺點**
- 循序執行，一次只做一件事
- 長對話後 context 越來越擁擠，影響判斷品質
- 大型 codebase 讀不完，靠摘要可能漏掉細節
- Opus 4.6 不是專門為 coding 優化，和 Codex 5.3 相比實作深度有差距

---

#### 三 Skill 組合（含 Opus 4.6 作為 orchestrator）

**優點**
- 平行執行：3 個任務各 30 分鐘 → 總等待時間 30 分鐘（不是 90）
- Codex 5.3 xhigh 規劃：讀過真正的程式碼後才出計畫，比純推理更貼近實際
- 架構地圖跨 session 持久，每次開新對話 agent 仍知道架構
- 每個 agent 獨立 context，不受長對話影響
- 超大型專案：多個 Claude Opus 視窗 × 多個 Codex agent = 大量平行

**缺點**
- 每個 agent 啟動有 10–40 分鐘開銷，小任務殺雞用牛刀
- 執行中較難即時互動（exec 模式為主）
- 活動件多（map、plan、agents），出錯時需要判斷是哪一層的問題
- API 成本高於 Opus 4.6 單獨使用

---

#### 什麼時候用哪個？

| 場景 | 建議 |
|------|------|
| 改 typo、調 config、解釋程式碼 | **Opus 4.6 單獨**，即時最快 |
| 單一功能、多檔案、需求明確 | **codex-orchestrator**（不一定需要 codex-plan）|
| 複雜功能、需要深入規劃、架構影響大 | **codex-plan → codex-orchestrator**（Codex 5.3 規劃+執行）|
| 新專案第一次開工 | **cartographer → codex-plan → codex-orchestrator** 完整流水線 |
| 多個互不依賴的任務 | **codex-orchestrator** 平行派發 |
| 安全審查、重要改動需交叉驗證 | **codex-orchestrator** 搭配 `--provider gemini` 做跨模型分析 |
| 大量檔案的 context-heavy 分析 | **codex-orchestrator** 搭配 `--provider gemini`（Gemini context 窗口優勢）|
| 超大型系統重構 | 多個 Claude Opus 視窗各帶 codex-orchestrator 軍團 |

---

#### 一句話總結

> **Opus 4.6 單獨**：適合小任務和即時討論，反應快，推理強。
>
> **三 Skill 組合**：適合中大型任務，Codex 5.3 規劃+執行比 Opus 4.6 直接做更深，平行能力讓時間成本大幅壓縮。
>
> 兩者不互斥 — Opus 4.6 是 orchestrator，Codex 5.3 是執行軍團。

---

## Plugin 更新流程

當 `yelban/codex-orchestrator` 有新 commit 推送後，需手動同步三個位置：

### 1. Marketplace Clone（git pull）

```bash
git -C ~/.claude/plugins/marketplaces/codex-orchestrator-marketplace pull
```

若出現本地修改衝突（例如之前直接複製 SKILL.md 造成的 dirty state）：

```bash
# 捨棄本地修改再 pull（遠端已包含相同修正）
git -C ~/.claude/plugins/marketplaces/codex-orchestrator-marketplace \
  checkout -- plugins/codex-orchestrator/skills/codex-orchestrator/SKILL.md
git -C ~/.claude/plugins/marketplaces/codex-orchestrator-marketplace pull
```

### 2. Plugin Cache（手動複製 SKILL.md）

Plugin cache 不是 git clone，需手動複製：

```bash
cp ~/.claude/plugins/marketplaces/codex-orchestrator-marketplace/plugins/codex-orchestrator/skills/codex-orchestrator/SKILL.md \
   ~/.claude/plugins/cache/codex-orchestrator-marketplace/codex-orchestrator/1.0.0/skills/codex-orchestrator/SKILL.md
```

### 3. 驗證同步

```bash
diff \
  ~/.claude/plugins/marketplaces/codex-orchestrator-marketplace/plugins/codex-orchestrator/skills/codex-orchestrator/SKILL.md \
  ~/.claude/plugins/cache/codex-orchestrator-marketplace/codex-orchestrator/1.0.0/skills/codex-orchestrator/SKILL.md \
  && echo "IDENTICAL"
```

### 為什麼有三個位置？

| 位置 | 說明 |
|------|------|
| `~/zoo/codex-orchestrator/`（或任何開發目錄）| 原始碼，git push 的來源 |
| `~/.claude/plugins/marketplaces/codex-orchestrator-marketplace/` | Claude Code 的 marketplace clone，git pull 可同步 |
| `~/.claude/plugins/cache/codex-orchestrator-marketplace/` | Claude Code 實際讀取的 plugin cache，需手動複製 |

Claude Code 啟動時讀取 **plugin cache** 的 SKILL.md，所以光是 git pull marketplace clone 還不夠，cache 也要手動同步。

---

## 注意事項

- **分 phase 實作**：大型任務拆 phase，每個 phase 確認無誤再繼續，不要一次派 agent 做全部
- **不要在 agent 跑中間改相同的檔案**：會造成衝突
- **PRD 是合約**：agent 會嚴格照 PRD 做，PRD 寫得清楚，agent 就做得準
- **中途 kill 是最後手段**：除非 agent 真的跑錯方向，否則讓它跑完
- **跨模型並行時至少一方 read-only**：兩個 agent 同時寫入會造成檔案衝突。Gemini 預設 read-only，如需寫入請改為循序執行
- **跨模型共識 ≠ 正確**：兩個模型的訓練資料有重疊，達成共識不代表答案正確。在專案特定程式碼上的分析才最有價值
