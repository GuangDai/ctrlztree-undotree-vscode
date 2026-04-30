# CtrlZTree V4 Implementation TODO Plan

日期：2026-04-29  
状态：执行计划草案  
唯一设计依据：`UPGRADE_DESIGN_PLAN-V4-CodeX.md`  
协作规则依据：`AGENTS.md`  

本文把 V4 拆成可逐步推进的小任务。每个任务尽量做到小、可审查、可测试、可回滚。默认执行顺序从 W1/W2 开始，不跳到 AI、大 UI、持久化换芯或事件日志大重构。

---

## 0. 执行原则

| 原则 | 执行要求 |
|---|---|
| 小步提交 | 每个 TODO 只解决一个清晰问题，避免同时改架构、UI、测试、配置。 |
| 先地基后功能 | 先恢复 toolchain、测试、安全、一致性，再做事件日志、TreeView、AI、持久化。 |
| 红线不碰 | 不接入 Copilot，不用 `vscode.lm`，不引入明文 API key，不引入明文历史持久化。 |
| 可验证 | 每个代码任务至少有 compile 或定向测试；无法运行必须记录原因。 |
| 可回滚 | 每个任务都能独立回滚，不依赖后续大重构才能稳定。 |
| 兼容旧行为 | 触碰 legacy `CtrlZTree` 时必须保护当前 undo/redo/branch 行为。 |

---

## 1. 总体阶段看板

| 阶段 | 目标 | 状态 | 完成门槛 |
|---|---|---|---|
| W0 | 设计冻结与执行规范 | 已完成 | `UPGRADE_DESIGN_PLAN-V4-CodeX.md`、`AGENTS.md`、本文存在。 |
| W1 | Toolchain + P0 安全修复 | 未开始 | compile/lint/test harness 可运行；URI/Webview/diff/config P0 风险关闭。 |
| W2 | 一致性事务 | 未开始 | apply false/reject 不提交 head；自触发编辑不误记；队列和 token 基础可用。 |
| W3 | 事件日志地基 | 未开始 | events/projection/contentStore/legacy adapter/golden tests。 |
| W4 | 历史操作 | 未开始 | merge/delete/prune plan + invariant tests。 |
| W5 | TreeView 主入口 | 未开始 | TreeView 可浏览和操作历史；Webview 降权。 |
| W6 | 加密持久化 | 未开始 | encrypted round-trip、quota、clear/export/import。 |
| W7 | Webview 图谱优化 | 未开始 | graph protocol、CSP、renderer benchmark。 |
| W8 | AI Provider | 未开始 | SecretStorage、Redactor、ProviderRegistry、Scheduler、OperationPlanner。 |
| W9 | 兼容与压力硬化 | 未开始 | Remote/Web/多文档/取消/压力测试。 |
| W10 | 发布准备 | 未开始 | README/CHANGELOG/migration/CI gates。 |

---

## 2. W1：Toolchain + P0 安全修复

### W1.1 基线检查与依赖状态记录

| 项 | 内容 |
|---|---|
| 目标 | 明确当前 compile/lint/test 是否可运行，记录阻塞。 |
| 文件范围 | 无代码改动，必要时只更新本文状态。 |
| 前置 | 无。 |
| 步骤 | 运行 `npm run compile`、`npm run lint`、`npm test`；若缺依赖，记录错误。 |
| 验收 | 明确知道本地验证能力；不假装通过。 |
| 测试 | 命令本身即验证。 |
| 回滚 | 无。 |

### W1.2 修正 package-lock 版本与测试脚本基线

| 项 | 内容 |
|---|---|
| 目标 | 解决 `package.json` 与 `package-lock.json` 根版本不一致；为后续测试添加可用脚本结构。 |
| 文件范围 | `package-lock.json`、`package.json`、`src/test/**`。 |
| 前置 | W1.1。 |
| 小步骤 | 1. 检查 lock root version。2. 对齐版本。3. 保留现有 `npm test`。4. 若添加 `test:unit`，不要破坏 VS Code integration。 |
| 验收 | lock 版本与 package 版本一致；脚本命名符合 V4/AGENTS。 |
| 测试 | `npm run compile`，可行时 `npm test`。 |
| 回滚 | 回退 package 脚本与 lock 变更。 |

### W1.3 新增 DiffContentRegistry

| 项 | 内容 |
|---|---|
| 目标 | 关闭“diff/source content embedded in URI query strings”风险。 |
| 文件范围 | 新增 `src/ui/diffContentRegistry.ts`；接入 `src/extension.ts` 或 `src/webview/webviewManager.ts`。 |
| 前置 | W1.1。 |
| 小步骤 | 1. 定义 registry record：original/modified/title/createdAt。2. 生成 opaque id。3. 提供 get/delete/clear。4. TextDocumentContentProvider 通过 id 取内容。5. URI 只包含 id 和 side，不含正文。 |
| 验收 | 打开 diff 时 URI query/path 不含源码片段。 |
| 测试 | registry unit test；Webview openDiff smoke。 |
| 回滚 | 恢复旧 content provider 和 openDiff URI。 |

### W1.4 Webview message schema guard

| 项 | 内容 |
|---|---|
| 目标 | Webview 任意 payload 不崩溃、不执行未授权动作。 |
| 文件范围 | 新增 `src/webview/messageSchema.ts` 或 `src/ui/graphWebview/graphProtocol.ts`；修改 `src/webview/webviewManager.ts`。 |
| 前置 | W1.1。 |
| 小步骤 | 1. 定义 union message type。2. 为 `webviewReady/openDiff/navigate/requestTreeReload/requestTreeReset/webviewError` 写 type guard。3. switch 前校验。4. 非法 payload 记录 warning 并忽略。 |
| 验收 | malformed payload 不访问 nested field，不调用 handler。 |
| 测试 | 单元测试 type guard；集成或 mock 测试 malformed message。 |
| 回滚 | 回退 message guard 接入。 |

### W1.5 Webview HTML title escape 与 CSP 收紧

| 项 | 内容 |
|---|---|
| 目标 | 防止文件名注入 HTML，减少 CSP 放宽。 |
| 文件范围 | `src/webview/webviewManager.ts`、`src/webview/webview.html`。 |
| 前置 | W1.4 可并行，但建议先做 message guard。 |
| 小步骤 | 1. 新增 HTML escape helper。2. `%TITLE%` 使用 escape 后文本。3. 检查 `unsafe-inline` 是否必要。4. 若暂不能移除，记录原因并添加 TODO。 |
| 验收 | 文件名 `"><script>alert(1)</script>` 不进入可执行 HTML。 |
| 测试 | helper unit test；模板生成测试。 |
| 回滚 | 恢复模板替换。 |

### W1.6 ConfigService 最小版本

| 项 | 内容 |
|---|---|
| 目标 | 运行时 clamp 当前三个配置，减少魔法数字风险。 |
| 文件范围 | 新增 `src/config/defaults.ts`、`src/config/configService.ts`；修改 `src/extension.ts`、必要时 `package.json`。 |
| 前置 | W1.1。 |
| 小步骤 | 1. 提取默认值。2. 提供 `readConfig()`。3. clamp `enablePruning/maxHistoryNodesPerDocument/maxTrackedDocuments`。4. 替换 extension 内部 `getConfig`。5. 对非法值输出 warning。 |
| 验收 | `maxTrackedDocuments=0` 不会导致删除全部 closed history；`maxHistoryNodesPerDocument` 低于最小值会被 clamp。 |
| 测试 | ConfigService unit tests。 |
| 回滚 | 恢复 extension 内部 getConfig。 |

### W1.7 strict diff schema validation

| 项 | 内容 |
|---|---|
| 目标 | `deserializeDiff` 对非法 op fail closed。 |
| 文件范围 | `src/lcs.ts` 或新增 `src/history/diffSchema.ts` 并由 `lcs.ts` 调用。 |
| 前置 | W1.1。 |
| 小步骤 | 1. 定义 `isDiffOperation`。2. 校验 type/position/length/content。3. 校验非负整数和字段组合。4. 非法数组项抛明确错误。5. 保持合法旧 diff 可读。 |
| 验收 | `[{"type":"keep","position":"x"}]` 抛错，不被 apply。 |
| 测试 | add/remove/keep/invalid JSON/invalid op/Unicode。 |
| 回滚 | 恢复旧 deserializeDiff。 |

### W1.8 groupIntoHunks O(n²) 修复

| 项 | 内容 |
|---|---|
| 目标 | 去掉 `operations.indexOf(op)`，避免大 diff 摘要退化。 |
| 文件范围 | `src/lcs.ts`。 |
| 前置 | W1.7 后更安全。 |
| 小步骤 | 1. 将 for-of 改为 index loop。2. 用 `i < operations.length - 1` 判断。3. 保持输出兼容。 |
| 验收 | 现有 diff summary 输出不变；大输入不明显退化。 |
| 测试 | generateUnifiedDiff 快照/断言；性能 smoke。 |
| 回滚 | 恢复旧循环。 |

---

## 3. W2：一致性事务

### W2.1 ApplyEditTokenSet

| 项 | 内容 |
|---|---|
| 目标 | 替换全局 `isApplyingEdit` boolean 的风险路径。 |
| 文件范围 | 新增 `src/concurrency/applyEditTokens.ts`；修改 `src/extension.ts`、`src/webview/webviewManager.ts`、`src/services/changeTracker.ts`。 |
| 前置 | W1 关键安全修复完成。 |
| 小步骤 | 1. 定义 token 类型。2. 支持 begin/end/isApplying。3. end 校验 token id。4. changeTracker 改为按 doc 判断。5. 保留兼容 shim，逐步移除 boolean。 |
| 验收 | 嵌套 apply 不会永久吞事件；跨文档 apply 互不影响。 |
| 测试 | token unit tests；changeTracker mock tests。 |
| 回滚 | 恢复 boolean 接口。 |

### W2.2 applyEditAndVerify

| 项 | 内容 |
|---|---|
| 目标 | apply false/reject 不提交 head move，解决树头和文档不一致。 |
| 文件范围 | 新增 `src/utils/editorApply.ts` 或 `src/history/historyController.ts`；修改 undo/redo/navigate。 |
| 前置 | W2.1。 |
| 小步骤 | 1. 生成 fullRange helper。2. apply 前 begin token。3. `applyEdit` false 返回失败。4. reject 返回失败。5. apply 后验证 document text。6. cursor clamp。 |
| 验收 | apply false/reject 时 head 回到旧值或完全不移动。 |
| 测试 | mock apply false/reject/success。 |
| 回滚 | 恢复旧 apply functions。 |

### W2.3 redo 单分支事务修复

| 项 | 内容 |
|---|---|
| 目标 | 当前 `tree.y()` 会先改 head，apply 失败无法回滚；先在 legacy 层修补。 |
| 文件范围 | `src/model/ctrlZTree.ts`、`src/extension.ts`。 |
| 前置 | W2.2。 |
| 小步骤 | 1. 增加 peek redo children 方法或在 command 中先读取 children。2. 选择 target 后 apply target content。3. apply 成功再 setHead。4. 多分支取消保持不变。 |
| 验收 | apply failure 后 `tree.getHead()` 未变化。 |
| 测试 | redo single branch apply false/reject。 |
| 回滚 | 恢复旧 redo flow。 |

### W2.4 Webview navigate 事务修复

| 项 | 内容 |
|---|---|
| 目标 | navigate 不再先 setHead 后 apply。 |
| 文件范围 | `src/webview/webviewManager.ts`，可能新增 controller/helper。 |
| 前置 | W2.2。 |
| 小步骤 | 1. resolve full hash。2. 读取 target content/cursor。3. applyAndVerify。4. 成功后 setHead。5. 失败不更新 panel head。 |
| 验收 | navigate apply false/reject 不改变 head。 |
| 测试 | mock Webview navigate failure。 |
| 回滚 | 恢复旧 handler。 |

### W2.5 DocumentTaskQueue 最小版本

| 项 | 内容 |
|---|---|
| 目标 | 为后续写路径串行化打地基，先不大改所有调用。 |
| 文件范围 | 新增 `src/concurrency/documentTaskQueue.ts`；小范围接入 changeTracker 或 controller。 |
| 前置 | W2.1-W2.4。 |
| 小步骤 | 1. per-doc promise chain。2. pending count。3. cancelPending 标记。4. 防同 doc 嵌套 enqueue。5. 单元测试 FIFO。 |
| 验收 | 同 doc task FIFO；跨 doc 不互堵。 |
| 测试 | queue unit tests。 |
| 回滚 | 删除新模块与接入点。 |

---

## 4. W3：事件日志地基

### W3.1 定义 ids/events 类型

| 项 | 内容 |
|---|---|
| 目标 | 建立新历史模型的类型基础，不接入 runtime。 |
| 文件范围 | `src/history/ids.ts`、`src/history/events.ts`。 |
| 前置 | W1/W2 稳定。 |
| 小步骤 | 1. 定义 DocId/NodeId/EventSeq/ContentHash。2. 定义 EventBase 和 Init/Edit/HeadMove/Rename/Summarize/Protect/Merge/Prune/Archive/Delete/Reset。3. 添加 schemaVersion。 |
| 验收 | 编译通过，类型清晰。 |
| 测试 | 类型级/简单 event fixture tests。 |
| 回滚 | 删除新文件。 |

### W3.2 Projection 纯函数

| 项 | 内容 |
|---|---|
| 目标 | `project(events)` 生成 Projection，并校验不变量。 |
| 文件范围 | `src/history/projection.ts`。 |
| 前置 | W3.1。 |
| 小步骤 | 1. 处理 init/edit/headMove。2. 添加 parent/children maps。3. 添加 archived/deleted/protected。4. 输出 diagnostics。5. 不依赖 VS Code。 |
| 验收 | 基本事件流可投影，非法流 fail closed 或 diagnostics 明确。 |
| 测试 | unit + invariant tests。 |
| 回滚 | 删除 projection 模块。 |

### W3.3 ContentStore 内存版

| 项 | 内容 |
|---|---|
| 目标 | 先实现内存 ContentStore，支持 diff/snapshot/LRU。 |
| 文件范围 | `src/history/contentStore.ts`。 |
| 前置 | W1.7、W3.1。 |
| 小步骤 | 1. appendEdit。2. snapshot threshold。3. resolve。4. LRU 简化实现。5. schema validation。 |
| 验收 | resolve 任意节点内容正确。 |
| 测试 | small diff/big snapshot/deep chain/cache。 |
| 回滚 | 删除模块。 |

### W3.4 legacy CtrlZTree golden fixtures

| 项 | 内容 |
|---|---|
| 目标 | 锁住现有行为，为迁移提供安全网。 |
| 文件范围 | `src/test/**`、fixtures。 |
| 前置 | W1 toolchain 可用。 |
| 小步骤 | 1. 构造 edit/undo/redo/branch fixture。2. 记录 expected content/head behavior。3. 标记当前已知缺陷不要误认为目标行为。 |
| 验收 | golden tests 可稳定运行。 |
| 测试 | 本任务本身。 |
| 回滚 | 删除 fixtures/tests。 |

### W3.5 legacy adapter 草案

| 项 | 内容 |
|---|---|
| 目标 | 将旧树转换为事件流，不替换 runtime。 |
| 文件范围 | `src/history/legacyCtrlZTreeAdapter.ts`。 |
| 前置 | W3.1-W3.4。 |
| 小步骤 | 1. 遍历旧 nodes。2. 为每个旧节点分配 NodeId。3. 生成 init/edit/headMove。4. 对比 projection 内容。 |
| 验收 | sample legacy tree 转换后内容等价。 |
| 测试 | adapter fixture tests。 |
| 回滚 | 删除 adapter。 |

---

## 5. W4：历史操作

### W4.1 OperationPlan 类型和校验

| 项 | 内容 |
|---|---|
| 目标 | merge/delete/prune 的统一 plan 基础。 |
| 文件范围 | `src/history/operationPreview.ts` 或 `operationPlan.ts`。 |
| 前置 | W3 Projection。 |
| 小步骤 | 1. 定义 plan 类型。2. 校验 baseSeq。3. 校验 targetIds。4. risk/requiresConfirmation。 |
| 验收 | stale/missing/protected target 被拒绝。 |
| 测试 | unit tests。 |

### W4.2 PruningEngine

| 项 | 内容 |
|---|---|
| 目标 | 最大备份数、保留 head path、protected/named、branch tips。 |
| 文件范围 | `src/history/pruningEngine.ts`。 |
| 前置 | W4.1。 |
| 小步骤 | 1. keep priority。2. archive plan。3. delete archived only。4. estimatedBytesFreed。 |
| 验收 | 自动剪枝不 hard delete；head path 全保留。 |
| 测试 | invariant/property tests。 |

### W4.3 MergeEngine

| 项 | 内容 |
|---|---|
| 目标 | 支持 typing burst/whitespace/linear squash plan。 |
| 文件范围 | `src/history/mergeEngine.ts`。 |
| 前置 | W4.1。 |
| 小步骤 | 1. 校验 linear chain。2. 生成 result content ref。3. 源节点 archive。4. preview diff。 |
| 验收 | 非线性合并拒绝；合并后 content 等价。 |
| 测试 | unit + invariant tests。 |

### W4.4 Delete/Archive 操作

| 项 | 内容 |
|---|---|
| 目标 | delete leaf/branch/archive/hard delete 规则落地。 |
| 文件范围 | `src/history/deleteEngine.ts` 或并入 operation planner。 |
| 前置 | W4.1。 |
| 小步骤 | 1. delete head 拒绝。2. delete protected 拒绝。3. branch delete 到 shared ancestor。4. hard delete 二次确认标记。 |
| 验收 | 不产生 dangling parent/children。 |
| 测试 | unit/property tests。 |

---

## 6. W5：TreeView 主入口

### W5.1 package contributes.views

| 项 | 内容 |
|---|---|
| 目标 | 注册 CtrlZTree side bar/tree views。 |
| 文件范围 | `package.json`、`src/ui/historyTreeProvider.ts`。 |
| 前置 | W3 或 legacy adapter 可提供 snapshot。 |
| 验收 | VS Code 出现历史树入口。 |
| 测试 | integration smoke。 |

### W5.2 HistoryTreeProvider

| 项 | 内容 |
|---|---|
| 目标 | 展示 Head、Current Branch、Branch Tips、Named/Protected、Archived。 |
| 文件范围 | `src/ui/historyTreeProvider.ts`。 |
| 前置 | W5.1。 |
| 验收 | 1000 节点懒加载不过度卡顿。 |
| 测试 | provider unit + UI integration。 |

### W5.3 Tree commands

| 项 | 内容 |
|---|---|
| 目标 | checkout、diff、rename、protect、archive 等命令走 controller。 |
| 文件范围 | `src/commands/historyCommands.ts`、`src/ui/**`。 |
| 前置 | W5.2、W2 controller path。 |
| 验收 | contextValue 控制命令可见性，执行前重新校验节点。 |
| 测试 | command integration。 |

---

## 7. W6：加密持久化

### W6.1 SecretStore wrapper

| 项 | 内容 |
|---|---|
| 目标 | 统一 SecretStorage 访问；不可用时 fail closed。 |
| 文件范围 | `src/ai/secretStore.ts` 或 `src/security/secretStore.ts`。 |
| 前置 | W1/W2。 |
| 验收 | 不可用时 AI/persistence disabled，不写明文。 |
| 测试 | mock SecretStorage success/failure。 |

### W6.2 PersistenceStore encrypted round-trip

| 项 | 内容 |
|---|---|
| 目标 | events/snapshots 加密落盘并可恢复。 |
| 文件范围 | `src/history/persistenceStore.ts`。 |
| 前置 | W3 ContentStore/events。 |
| 验收 | 文件扫描不可读出源码片段。 |
| 测试 | encrypted round-trip/corrupt file/schema mismatch。 |

### W6.3 Usage/Clear/Export/Import commands

| 项 | 内容 |
|---|---|
| 目标 | 用户可查看、清理、加密导出导入历史。 |
| 文件范围 | `src/commands/persistenceCommands.ts`。 |
| 前置 | W6.2。 |
| 验收 | clear 二次确认；export encrypted only。 |
| 测试 | command integration + security scan。 |

---

## 8. W7：Webview 图谱优化

### W7.1 Graph protocol

| 项 | 内容 |
|---|---|
| 目标 | `init/patch/select/diff/expand` 协议替代全量裸 payload。 |
| 文件范围 | `src/ui/graphWebview/graphProtocol.ts`、`src/webview/**`。 |
| 前置 | W1.4。 |
| 验收 | message schema 覆盖所有协议。 |
| 测试 | protocol unit tests。 |

### W7.2 Renderer benchmark

| 项 | 内容 |
|---|---|
| 目标 | 用数据决定保留/替换 vis-network。 |
| 文件范围 | `tests/perf` 或 `src/test/perf`。 |
| 前置 | W7.1。 |
| 验收 | 300/1000 节点渲染基线报告。 |
| 测试 | benchmark output。 |

### W7.3 Renderer replacement or retention

| 项 | 内容 |
|---|---|
| 目标 | 若 SVG/Canvas 明显更优，再替换；否则只保留降权优化。 |
| 文件范围 | `src/webview/**`、`resources/**`。 |
| 前置 | W7.2。 |
| 验收 | 性能门槛达标且 CSP 不回退。 |
| 测试 | Webview smoke + benchmark。 |

---

## 9. W8：AI Provider 与 OperationPlanner

### W8.1 AI types and ProviderRegistry

| 项 | 内容 |
|---|---|
| 目标 | 定义统一 request/response/capability。 |
| 文件范围 | `src/ai/types.ts`、`src/ai/providers/base.ts`、`registry.ts`。 |
| 前置 | SecretStore wrapper。 |
| 验收 | 只有 V4 允许的四类 provider。 |
| 测试 | registry unit tests。 |

### W8.2 Redactor

| 项 | 内容 |
|---|---|
| 目标 | prompt 和日志脱敏。 |
| 文件范围 | `src/ai/redactor.ts`。 |
| 前置 | W8.1 可并行。 |
| 验收 | token/password/private key/URL secret/cloud creds 被替换。 |
| 测试 | security unit tests。 |

### W8.3 RequestScheduler

| 项 | 内容 |
|---|---|
| 目标 | 并发、限流、重试、超时、取消。 |
| 文件范围 | `src/concurrency/requestScheduler.ts`。 |
| 前置 | W2 queue 思路。 |
| 验收 | maxConcurrent/maxRequestsPerHour/timeout/retry 生效。 |
| 测试 | scheduler unit tests。 |

### W8.4 Provider adapters

| 项 | 内容 |
|---|---|
| 目标 | OpenAI Responses、OpenAI Chat-compatible、Anthropic Messages、custom-http-json。 |
| 文件范围 | `src/ai/providers/**`。 |
| 前置 | W8.1-W8.3。 |
| 验收 | contract fixture 通过；无真实 key。 |
| 测试 | provider contract tests。 |

### W8.5 PromptBuilder and OperationPlanner

| 项 | 内容 |
|---|---|
| 目标 | 最小上下文 prompt、schema 输出、plan 校验。 |
| 文件范围 | `src/ai/promptBuilder.ts`、`operationPlanner.ts`。 |
| 前置 | W4 operation plan。 |
| 验收 | invalid/stale/high-risk/destructive 全部 fail closed 或确认。 |
| 测试 | contract + security + autonomy matrix。 |

---

## 10. W9/W10：兼容、压力、发布

### W9.1 Compatibility matrix

| 项 | 内容 |
|---|---|
| 目标 | Remote/WSL/Web/低 VS Code/special scheme 行为明确。 |
| 文件范围 | docs/tests。 |
| 验收 | 不可用能力降级，不写明文 fallback。 |

### W9.2 Stress tests

| 项 | 内容 |
|---|---|
| 目标 | 多文档、长历史、大文件、快速输入、关闭文档压力。 |
| 文件范围 | `tests/perf`、integration tests。 |
| 验收 | 无竞态、无崩溃、性能门槛达标或有降级。 |

### W10.1 Release documentation

| 项 | 内容 |
|---|---|
| 目标 | README、CHANGELOG、migration notes 和安全说明。 |
| 文件范围 | docs/root markdown。 |
| 验收 | 用户知道 AI、持久化、密钥、剪枝行为。 |

### W10.2 CI gates

| 项 | 内容 |
|---|---|
| 目标 | PR fast/full/nightly/release gates 落地。 |
| 文件范围 | package scripts、CI config。 |
| 验收 | compile/lint/unit/contract/security/perf smoke 进入 CI。 |

---

## 11. 每个 TODO 的执行模板

开始前填写：

```md
## Task
- ID:
- V4 phase:
- Risk/defect addressed:
- Files in scope:
- Out of scope:

## Plan
- [ ] Step 1
- [ ] Step 2
- [ ] Step 3

## Verification
- [ ] Compile:
- [ ] Tests:
- [ ] Manual smoke:

## Rollback
- Revert files:
- Known migration impact:
```

完成后记录：

```md
## Result
- Changed:
- Tests run:
- Tests not run:
- Residual risk:
- Next recommended TODO:
```

---

## 12. 建议立即执行的前三个最小任务

| 顺序 | 任务 | 为什么先做 | 预计改动 |
|---:|---|---|---|
| 1 | W1.1 基线检查 | 先知道 compile/test 是否可用，避免盲改。 | 无代码改动。 |
| 2 | W1.7 strict diff schema validation | 纯逻辑、范围小、P0 风险高、易测试。 | `src/lcs.ts` + tests。 |
| 3 | W1.6 ConfigService 最小版本 | 范围较小，可降低运行时配置风险。 | `src/config/**` + `src/extension.ts` + tests。 |

如果依赖未安装导致测试无法运行，先做 W1.1 记录，然后决定是否恢复依赖/toolchain。

