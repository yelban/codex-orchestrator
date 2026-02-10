# Codex Orchestrator Plugin 使用指南：條件、效果與比較

> 對話日期：2026-02-10

## 使用這個 Plugin 能做什麼？

安裝 codex-orchestrator plugin 後，Claude Code 能自動指揮 OpenAI Codex agents 編寫程式碼。Claude 扮演策略指揮官，Codex agents 作為平行執行的 coding 專家。

## 使用前提條件

| 條件 | 說明 |
|------|------|
| tmux | `brew install tmux` |
| Bun | JavaScript runtime（`curl -fsSL https://bun.sh/install \| bash`） |
| OpenAI Codex CLI | `npm install -g @openai/codex` |
| OpenAI 認證 | `codex --login` |

### ChatGPT Plus 訂閱 ≠ OpenAI API 額度

ChatGPT Plus 是 ChatGPT 網頁/App 的訂閱方案。Codex CLI 早期需要獨立的 API key + 額度，但後來 OpenAI 讓 Plus/Pro 訂閱者可以透過 `codex --login` 直接使用帳號認證。

建議直接跑 `codex --login` 確認你的 Plus 方案是否包含 `gpt-5.3-codex` 模型的存取權限——OpenAI 的政策可能有更新。

## 架構差異

```
單獨 Opus 4.6:
  使用者 → Claude (思考 + 實作，全部自己來)

加上 Codex Orchestrator:
  使用者 → Claude (策略規劃、任務拆解、結果彙整)
               ├── Codex agent #1 (平行實作)
               ├── Codex agent #2 (平行研究)
               └── Codex agent #3 (平行審查)
```

## 單獨 Opus 4.6 vs Opus + Codex 編隊

| 面向 | 單獨 Opus 4.6 | Opus + Codex 編隊 |
|------|--------------|------------------|
| **平行度** | 單線程，一次做一件事 | 可同時派出多個 agent 平行工作 |
| **角色分工** | Claude 既要思考又要實作 | Claude 專注策略，Codex 專注 coding |
| **速度（小任務）** | 更快，直接做 | 較慢，agent 啟動 + tmux 同步有延遲 |
| **速度（大任務）** | 受限單一 context window | 多 agent 平行，總產出更高 |
| **程式碼品質** | Opus 4.6 程式碼能力很強 | Codex 模型專門為 coding 優化，會深入讀 codebase、仔細實作 |
| **成本** | 只付 Anthropic | 同時付 Anthropic + OpenAI |
| **複雜度** | 簡單直接 | 多了 tmux session 管理、agent 協調、log 解析 |
| **Agent 耗時** | 即時回應 | 單個 agent 可能跑 10-60+ 分鐘（正常現象） |

## 適用場景建議

### 適合 Codex 編隊

- 大規模 codebase 重構（多模組同時改）
- 需要平行調查不同部分（安全審查、架構分析）
- 長時間的實作任務（你可以同時跟 Claude 討論下一步）
- 開多個 Claude Code 視窗，每個各自指揮 Codex 軍團

### 不需要 Codex 編隊

- 小型修改、單檔 bug fix
- 快速問答或程式碼解釋
- 對延遲敏感的互動式開發

## 務實結論

如果日常開發以中小型任務為主，**單獨 Opus 4.6 已經非常強大**，回應即時、程式碼品質高。Codex Orchestrator 的價值在於「規模化」——當需要同時處理很多事情，或者任務大到一個 agent 做不完時，才真正發揮優勢。

可以先安裝起來，跑個 `codex-agent health` 確認環境就緒，然後用一個小任務感受流程。
