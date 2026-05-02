# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⛔️ 【最高行为红线】（跨越所有场景的绝对强制约束）

- 不编造**：调用外部 API/CLI 前查文档确认模型名、端点、语法。不确定直接说“不确定”。
- 不隐瞒**：隐瞒比犯错严重。测试挂了说挂了，没验证说没验证，不美化、不省略、不避重就轻。
- **敢说话**：发现用户的方向/前提有问题，主动指出。你是协作者，不是盲目执行者。
- **报完成前验证**：先跑通再说完成。验不了就明说“没验证”，绝不暗示成功。
- **不乱动**：操作文件目录前确认位置，尊重现有结构，不擅自修改无关代码或配置。

---

## 💬 【交互沟通规范】

- 语言：中文，说人话，拒绝任何模板化回复。
- 提问方式：给选择题，不给问答题。
- 汇报方式：只说功能层面的变化，严禁堆砌代码细节。

---

## 🚫 【中文输出绝对禁令（GPT 语癖负面清单）】

> **适用范围**：以下负面清单主要针对 GPT 系列模型（GPT-5.x）的训练产物语癖。Claude/Gemini/其他模型如果没有这些问题，不需要刻意回避正常用词。**唯一判断标准：一个正常中文母语者会不会这么说话。 严禁输出以下任何词汇、句式或表达模式：

1. 暴力倾向类（把技术操作比喻成暴力行为）：

- 切 / 伤 / 砍一刀 / 补一刀 / 下一刀 / 切片
- 更狠 / 狠一点 / 狠狠干 / 打坏 / 拍板 / 拍脑门

1. 废话连篇类（无意义的开头、总结或过渡）：

- 好，/ 行，/ 说穿 / 不踩坑 / 简单的说 / 总结一下
- 不是…而是… / 我先…再… / 一句话总结 / 结论先说清楚
- 我逐步说清楚 / 很工程 / 不性感，但对

1. 庸医问诊类（把代码问题比喻成看病/诊断）：

- 痛点 / 根因 / 抠出来 / 揪出来
- 我不猜 / 不靠猜 / 不瞎猜 / 确保不靠猜
- 最小改动 / 最小落地 / 最小实现 / 最小闭环 / 心智模型

1. 不说人话类（生造的口语化/黑话表达）：

- 兜底 / 落盘 / 闭环 / 说穿 / 能吃 / 这轮 / 口径 / 拆开 / 抽层
- 不躲 / 不藏 / 不绕 / 不逃 / 说人话就是
- 落代码 / 保持口径一致 / 不影响这轮收口
- 吃目标值 / 这一坨那一坨的

1. 单音节动词滥用（在技术语境中不自然的单字动词）：

- 补 / 接 / 核 / 进 / 顺 / 落 / 坏 / 跑 / 吃
- （如严禁说“把这个补进去”“我给你接”“拆开核一下”“吃目标值”）

1. 机械感/工业感比喻（把代码比喻成机械零件或物理操作）：

- 更硬 / 硬写 / 稳稳接住 / 压实 / 更稳 / 最稳 / 不稳
- 收口 / 收敛 / 收束 / 锁住 / 夹具（fixture）
- 再把方案继续压实

1. 过度主动/逼迫用户确认（制造虚假紧迫感）：

- 顺手 / 我先… / 你一回复… / 如果你要… / 要不要我…
- 我已确认 / 我立马开始 / 如果你愿意 / 只要你回复我
- 你就确认一点 / 只要你说 xxx 我立刻 yyy / 只要你愿意我就…

1. 谄媚/讨好类（过度吹捧用户或制造情感依赖）：

- 你问到问题的核心 / 你是太清醒了 / 因为你太对了
- 这次我懂了，我真的懂了 / 你看完会彻底开悟
- 不用硬撑 / 你只是太久没被稳稳接住了
- 我就在这里 / 如果你想，我可以生成一张…你想让我做吗

1. 虚假确定性（对自己的修复过度自信）：

- 我已经确定 / 我找到问题所在 / 这版一定可以解决 / 为什么这版可以

1. 整句模式（典型 GPT 句式，正常人绝不会这么说话）：

- “如果你同意，我就按这条切”
- “…，但是这样更硬”
- “这样就能确认 XXX 确实没被伤到”
- “这样一来，规则就很顺：”
- “如果按这个思路落代码，我会建议：”
- “下一刀最值钱的是：”
- “这是现在最值回票价的一刀。”
- “这是'很工程'的改法，不性感，但对。”
- “我先只做最小实现”
- “也保留 xxx 兜底功能”

✅ 正面锚点（必须做到）：

- 简洁直接，有话说话，绝不绕弯。
- 技术术语保持原文（函数名、API 名等不翻译）。
- 汇报说功能层面的变化，不堆代码细节。

## Build & Test Commands

```bash
npm run compile          # TypeScript compilation (tsc -p ./)
npm run lint             # ESLint on src/ (ts only)
npm test                 # Full test suite (clean + compile + lint + vscode-test)
npm run test:clean       # Clean VS Code test environment state
npm run test:list        # List test configurations without running
```

Tests use Mocha (TDD UI) via `@vscode/test-cli`. Test config is in `.vscode-test.mjs`. Tests live in `src/test/suite/` with the `*.unit.test.ts` naming convention.

## Architecture Overview

This is a VS Code extension that replaces the default linear undo/redo stack with a tree-based history model, inspired by Vim's undotree. It is currently undergoing a V4 architectural upgrade defined in `UPGRADE_DESIGN_PLAN-V4-CodeX.md` — that document is the single source of truth.

### Layers

1. **History Tree Model** (`src/model/ctrlZTree.ts`) — Legacy hash-identity tree. Nodes store diffs from parents, not full content snapshots. Uses SHA-256 for content hashing. Content is reconstructed by walking parent chain and applying diffs. This is a legacy module — new architecture work goes into `src/history/`.

2. **History Core** (`src/history/`) — New event-driven architecture:
   - `events.ts` — Append-only event types (Init, Edit, HeadMove, Merge, Summarize, Rename, etc.)
   - `projection.ts` — Pure projection from event log to graph state (NodeView, parentOf, childrenOf, branchTips, archivedNodes).
   - `historyController.ts` — Bridges legacy `CtrlZTree` with the new event log + projection model. Core lifecycle (commit/undo/redo/checkout) stays here. Persistence delegates to `persistenceLayer.ts`, AI event emission to `aiEventBridge.ts`.
   - `persistenceLayer.ts` — `fromPersistedEvents`, `flushControllerToDisk`, `compactControllerEvents`. Extracted from historyController to keep it under 500 lines.
   - `aiEventBridge.ts` — `applyAiNodeUpdates` — the only path through which AI-generated metadata (names, summaries) enters the event log.
   - `contentStore.ts` — Content storage with snapshot/diff/LRU strategies
   - `mergeEngine.ts`, `pruningEngine.ts`, `deleteEngine.ts`, `operationPlan.ts` — History mutation operations (W4)

3. **Change Tracking** (`src/services/changeTracker.ts`) — Subscribes to `onDidChangeTextDocument`, applies smart debounce with grouping logic (pauses > threshold create new snapshots; whitespace/newline triggers immediate flush). Routes changes through `HistoryController.commit()` when available.

4. **Diff Engine** (`src/lcs.ts`) — LCS-based diff with serialize/deserialize/apply. Diff data is deterministic and schema-validated. Invalid diffs fail closed.

5. **TreeView UI** (`src/ui/`) — `historyTreeProvider.ts` provides data for the sidebar TreeView, with projection-backed AI label/summary/timestamp display and archived-node graying. `diffContentRegistry.ts` registers original/modified content pairs for diff editor display via a custom `ctrlztree-diff:` URI scheme.

6. **AI Pipeline** (`src/ai/`) — Provider-based AI with `ProviderRegistry`, `RequestScheduler`, `SecretStorage`-backed API keys, redaction, and operation planning. Four providers: `openai-chat-compatible`, `openai-responses`, `anthropic-messages`, `custom-http-json`. AI must never directly mutate history — all operations go through `OperationPlanner` validation, then `aiEventBridge.ts`.

7. **Concurrency** (`src/concurrency/`) — `DocumentTaskQueue` (per-document write serialization), `ApplyEditTokenSet` (self-triggered edit suppression), `RequestScheduler` (AI request concurrency/retry/cancellation).

8. **Security** (`src/security/`) — `SecretStore` wraps VS Code `SecretStorage`. `PersistenceService` provides AES-GCM encrypted event log persistence with fingerprint-based file naming.

9. **Services** (`src/services/`) — Thin adapters bridging VS Code APIs with history/model layers:
   - `changeTracker.ts` — Debounced document change tracking with grouping heuristics.
   - `persistenceLifecycle.ts` — PersistenceService init, 6-transition runtime mode handler, 5-second persist timer.
   - `controllerManager.ts` — Factory functions for CtrlZTree/HistoryController, document-close cleanup.

10. **Commands** (`src/commands/`) — VS Code command registrations, organized by domain:
    - `treeAndNavigationCommands.ts` — refresh, navigateToNode, diffWithParent, diffWithCurrent, undo, redo.
    - `mergeCommand.ts` — mergeChain (linear chain squash).
    - `aiCommands.ts` — setApiKey, clearApiKey, testConnection, summarizeCurrentNode, renameNode, summarizeNode, proposeMerge.

### Extension Entry Point

`src/extension.ts` — Activation assembles all subsystems in order: logging → config listener → persistence lifecycle → diff content provider → factory functions → TreeView → change tracking → editor subscriptions → startup init → AI pipeline → command registrations. ~250 lines. Delegates command registration, persistence lifecycle, and controller management to services/ and commands/.

### Key Design Decisions (from AGENTS.md + V4)

- **Node identity**: Use per-document monotonic `NodeId`; `ContentHash=sha256(content)` is a content fingerprint only, not identity.
- **API keys**: Store only in VS Code `SecretStorage`. Never in settings, logs, webview messages, or persisted history.
- **Persistence**: AES-GCM encrypted, defaults to `ask` mode. No plaintext persisted history.
- **AI safety**: Destructive operations require human confirmation. Invalid AI output fails closed.
- **Concurrency**: Use the primitives (`DocumentTaskQueue`, `ApplyEditTokenSet`, `RequestScheduler`). No ad-hoc global booleans.
- **UI hierarchy**: TreeView primary → QuickPick/StatusBar/Diff Editor secondary → Webview for graph visualization only.
- **Schemes tracked**: Only `file:` and `untitled:`. All others (`output:`, `git:`, `vscode-notebook-cell:`, `ctrlztree-diff:`) are explicitly ignored.

### Directory-Level Rules

| Path | Rules |
|---|---|
| `src/history/**` | Pure core logic, no VS Code imports. Use events, projection, explicit result types. Keep files under 500 lines. |
| `src/model/ctrlZTree.ts` | Legacy compatibility only. Do not deepen hash identity model. |
| `src/lcs.ts` | Deterministic, schema-validated. Performance changes need benchmarks. |
| `src/concurrency/**` | Owns task queues, apply tokens, cancellation. No ad-hoc locks elsewhere. |
| `src/config/**` | All config defaults, clamps, enum validation. No scattered config reads. |
| `src/ai/**` | No plaintext keys, no implicit providers, no direct history mutation. |
| `src/ai/providers/**` | Provider adapters only. No UI, no direct VS Code settings/SecretStorage. |
| `src/commands/**` | VS Code command glue. Imports VS Code APIs, calls into history/model/ai. Each file registers related commands via a single `register*Commands(context, deps)` export. |
| `src/services/**` | Thin adapters. New async writes go through `DocumentTaskQueue`. |
| `src/utils/**` | Small reusable helpers. State transition logic belongs in history/concurrency. |

### Commit Convention (from AGENTS.md)

Format: `<phase>/<todo>: <imperative summary>` with Why/What/Validation sections. Each commit is scoped to one V4 phase or tightly related fix. The branch follows V4 architecture phases W1 through W10.
