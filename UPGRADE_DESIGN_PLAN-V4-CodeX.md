# CtrlZTree 2.x/3.x 最终升级设计方案 V4（CodeX 决定版）

日期：2026-04-29  
作者：CodeX  
状态：最终实施基准  
适用仓库：`ctrlztree-undotree-vscode`  
输入来源：`UPGRADE_DESIGN_PLAN.md`、`UPGRADE_DESIGN_PLAN-V2-Claude.md`、`UPGRADE_DESIGN_PLAN-V3-CodeX.md`、`WHITEBOX_TEST_PLAN.md`、当前 `src/` 源码、官方 OpenAI/Claude/VS Code 文档。  

本文是后续实现、评审、测试、验收、发布的唯一参阅文档。旧版 Upgrade 文档和 WhiteBox 文档只作为审计来源，不再作为独立执行依据。若后续实现与本文冲突，以本文为准；若本文未覆盖，以“安全默认、可验证优先、性能有基准、AI 不直接执行破坏性动作”为裁决原则。

---

## 0. 最终裁决摘要

| 主题 | V4 最终决策 |
|---|---|
| 核心历史模型 | 采用 append-only 事件日志、纯投影、ContentStore、Snapshot/Diff 混合存储。旧 `CtrlZTree` 通过适配层分阶段迁移，禁止一次性大爆炸替换。 |
| 节点 ID | 使用文档内单调递增 `NodeId` 作为主键；`ContentHash=sha256(content)` 只作内容指纹，不再用短 hash 或加盐 hash 当节点身份。 |
| 性能目标 | 所有“非常快”的承诺必须落到 benchmark：编辑、恢复、剪枝、TreeView 刷新、Webview 图谱、AI 调度都有 p50/p95 门槛。 |
| 安全模型 | AI 默认关闭；持久化默认询问；启用持久化后强制 AES-GCM 加密；API key 只存 VS Code SecretStorage；diff 内容不得进 URI、日志、错误消息或 Webview 不必要 payload。 |
| AI Provider | 只支持用户自管入口：`openai-responses`、`openai-chat-compatible`、`anthropic-messages`、`custom-http-json`。用户必须显式配置 endpoint/baseUrl 和自己的 API key。 |
| 禁止项 | 不接入 Copilot，不使用 `vscode.lm`，不探测隐式模型通道，不把任何平台模型作为 fallback，不支持生产明文历史文件或明文 API key。 |
| AI 行为边界 | AI 只能生成名称、摘要、结构化建议和 operation plan。合并、删除、剪枝、清理等破坏性动作默认必须人工确认。 |
| 并发模型 | 使用 `DocumentTaskQueue` 串行化单文档写路径，使用 `RequestScheduler` 控制 AI 请求并发、限流、重试、取消。禁止散落多套锁。 |
| UI 模型 | VS Code TreeView 是主入口；StatusBar、QuickPick、Diff Editor、Hover 辅助；Webview 只承担大图谱和复杂批量预览。 |
| 历史操作 | 最大备份数、合并、删除、剪枝都必须先生成 plan，再校验不变量，再执行事件。默认 archive 优先，hard delete 必须二次确认。 |
| 交付模型 | 采用“瀑布式阶段门 + V 模型验证映射”。每阶段先设计和验收标准，再实现，再以单元/契约/集成/性能/安全测试闭环。 |

---

## 1. 文档范围与取舍原则

### 1.1 范围

本文覆盖以下工程范围：

| 范围 | 内容 |
|---|---|
| 现状缺陷 | 当前源码的关键 P0/P1 风险、性能瓶颈、安全问题、可测试性问题。 |
| 目标架构 | 历史引擎、事件模型、ContentStore、投影、事务、并发、AI、UI、持久化、配置、测试。 |
| 接口草案 | 关键 TypeScript 类型、服务接口、Provider 契约、事件契约、操作 plan 契约。 |
| 配置策略 | 用户可见配置、高级配置、内部常量、clamp 规则、密钥处理。 |
| 测试与验收 | 白盒路径、单元/集成/契约/安全/性能/并发/e2e 测试矩阵和覆盖率门槛。 |
| 实施路线 | 阶段门、PR 拆分、风险回滚、迁移策略、发布策略。 |

### 1.2 不在范围

| 不做 | 原因 |
|---|---|
| 在 V4 文档阶段直接改运行时代码 | 用户要求先文档、思路、设计、风险、验收、测试准备。 |
| 接入任何隐式 AI 模型通道 | 用户明确要求不要使用 Copilot；安全上也要求用户完全掌控 endpoint 和 key。 |
| 把 AI 变成自动执行者 | 历史删除、合并、剪枝不可恢复风险高，AI 只能提出 plan。 |
| 为性能牺牲加密和密钥保护 | 安全底线高于局部性能便利。 |
| 一次性重写所有模块 | 回归风险过高；必须兼容适配、分阶段切流。 |

### 1.3 取舍原则

| 原则 | 说明 |
|---|---|
| 安全默认 | 默认关闭网络 AI、默认不持久化、启用持久化强制加密、破坏性操作确认。 |
| 可验证优先 | 核心逻辑尽量纯函数化；所有状态变化都有事件和 property test。 |
| 性能用数据说话 | 大文件、长历史、Webview、TreeView、AI 并发都需要 benchmark 和阈值。 |
| 与 VS Code 深度融合 | 能用 TreeView、Diff Editor、QuickPick、StatusBar 的场景不滥用 Webview。 |
| 兼容但不迁就坏设计 | 保留 OpenAI Chat-compatible 是为了兼容生态；保留旧模型适配层是为了降低风险，不是长期技术债。 |

---

## 2. 外部事实与文档依据

| 领域 | 官方依据 | V4 使用方式 |
|---|---|---|
| OpenAI Responses API | OpenAI API Reference: Responses Create，包含 `input`、`instructions`、`max_output_tokens`、tools、structured output 等能力。参考：https://developers.openai.com/api/reference/resources/responses/methods/create | `openai-responses` Provider 的默认字段映射。 |
| OpenAI Chat Completions | OpenAI API Reference: Chat Completions。官方新项目倾向 Responses，但 Chat Completions 仍是大量兼容端点事实标准。参考：https://platform.openai.com/docs/api-reference/chat/create-chat-completion | `openai-chat-compatible` Provider 兼容层。 |
| Claude Messages API | Anthropic/Claude Messages API 使用 `model`、`messages`、`max_tokens`，支持无状态多轮。参考：https://docs.anthropic.com/en/api/messages | `anthropic-messages` Provider。 |
| Claude Tool Use | Claude 工具定义包含 `tools`、`name`、`description`、`input_schema`，工具由客户端执行。参考：https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use | AI operation plan 用强 schema/tool 输出，客户端校验后才可展示或执行。 |
| VS Code Tree View | VS Code Extension Guide: Tree View 通过 `contributes.views` 和 `TreeDataProvider` 注册。参考：https://code.visualstudio.com/api/extension-guides/tree-view | 主 UI 入口。 |
| VS Code Webview | VS Code Webview guide 提醒 Webview 资源重，应在原生 API 不足时使用。参考：https://code.visualstudio.com/api/extension-guides/webview | Webview 降级为复杂图谱和批量预览。 |
| VS Code SecretStorage | VS Code API Reference: `ExtensionContext.secrets` 与 `SecretStorage` 用于敏感信息，平台实现会加密存储。参考：https://code.visualstudio.com/api/references/vscode-api | API key 和持久化数据密钥唯一生产存储位置。 |

---

## 3. 用户目标到设计交付映射

| 用户目标 | V4 设计落点 | 验收方式 |
|---|---|---|
| 更好、更强性能，非常快 | ContentStore LRU、snapshot/diff 策略、投影缓存、TreeView 懒加载、Webview 增量协议、benchmark 门槛 | `tests/perf` 输出 p50/p95；长历史和大文件达标。 |
| 非常安全 | SecretStorage、强制加密、脱敏、CSP、message schema、diff 内容隔离、AI 默认关闭 | 安全测试矩阵全部通过；日志和持久化扫描无敏感明文。 |
| 更可配置、减少魔法数字 | `ConfigService`、分层配置、运行时 clamp、默认值集中化 | 配置单元测试覆盖边界、非法值和动态变更。 |
| 最大备份数、合并、删除、剪枝 | `PruningEngine`、`MergeEngine`、`OperationPlanner`、archive/hard delete 区分 | plan 预览、不变量测试、回滚测试。 |
| 兼容 AI 自动命名、总结、操作 | AI 生成 metadata 和 operation plan；破坏性操作确认 | AI contract fixture、autonomy matrix、审批流测试。 |
| 适配 OpenAI 和 Claude 格式 | Provider registry + 统一请求 + 字段映射 | OpenAI Responses、OpenAI Chat-compatible、Anthropic Messages、custom HTTP contract 测试。 |
| 自定义模型、参数、最大请求数、并发 | `ai.model/baseUrl/maxConcurrentRequests/maxRequestsPerHour/timeout/retries/tokens/temperature/topP` | Config clamp + Scheduler 并发/限流测试。 |
| 线程安全、锁和互斥 | `DocumentTaskQueue` + `ApplyEditTokenSet` + `RequestScheduler` | 并发竞态、取消、关闭文档、applyEdit 失败测试。 |
| Tree 页面高性能、可操作、嵌入 VS Code | TreeView 主入口、contextValue、inline commands、Diff Editor、StatusBar、Graph Webview 辅助 | VS Code integration 和 UI smoke。 |
| 更兼容、更适配 | 特殊 scheme 排除、Remote/Web 降级、feature detection、旧模型适配层 | 兼容矩阵和降级测试。 |
| 实现前先写文档、设计、风险、V 模型/瀑布 | 本文即最终设计与验收文档 | 方案评审通过后才进入 W1。 |

---

## 4. 当前代码现状与关键缺陷

### 4.1 当前模块范围

| 模块 | 当前职责 | 主要外部依赖 | 关键风险 |
|---|---|---|---|
| `src/extension.ts` | 激活扩展、注册命令、管理全局状态、执行 undo/redo/visualize | VS Code workspace/window/commands/Uri/WorkspaceEdit | applyEdit 失败处理不完整；命令闭包难测试；配置只读未 clamp。 |
| `src/model/ctrlZTree.ts` | Map 维护历史树、hash 节点、diff 存储、undo/redo、裁剪 | Node crypto、`lcs` | hash 身份不稳定；深链重建慢；剪枝可能丢 redo 分支。 |
| `src/lcs.ts` | 字符级 diff/apply/serialize/summary | JSON parser | diff schema 弱；部分路径 O(n²)；非法 op 可能造成 silent corruption。 |
| `src/services/changeTracker.ts` | 文档变更监听、防抖、分组、写历史 | VS Code event、timer | processing flag 可能丢变更；关闭文档和 timer 竞态。 |
| `src/webview/webviewManager.ts` | Webview 生命周期、图数据、消息、导航、diff | Webview、fs、commands、tabGroups | message 无 schema；短 hash 映射碰撞；diff 内容进 URI；导航失败不回滚。 |
| `src/webview/webview.js/html/css` | vis-network 图谱前端 | Webview sandbox、DOM、vis | 大图性能、CSP、异常可观测性不足。 |
| `src/utils/editorState.ts` | 回到初始快照时尝试清 dirty | `workspace.fs`、`document.save` | 文件读取/save 失败只记日志；编码固定 UTF-8。 |
| `package.json` / lock | manifest、命令、配置、脚本 | npm、VS Code | 当前 `package.json` 与 `package-lock.json` 根版本不一致；本地缺 `tsc/eslint`。 |

### 4.2 P0/P1 缺陷清单

| 编号 | 位置 | 严重 | 问题 | V4 修复方向 |
|---|---|---|---|---|
| D01 | `ctrlZTree.ts:104-111` | P0 | hash 冲突/同内容不同 parent 时加盐，导致内容指纹不稳定 | `NodeId` 与 `ContentHash` 分离；content hash 永不加盐。 |
| D02 | `ctrlZTree.ts:238-269` | P0 | `pruneToMaxNodes` 直接删除 Map 节点，可能静默丢弃 redo 分支 | 使用 `PrunePlan` + `PruneEvent`；archive 优先；不变量测试。 |
| D03 | `extension.ts` undo/redo 路径 | P0 | applyEdit 返回 false 或 reject 后树头可能已变化 | `applyEditAndVerify`；事务先验证再提交 head move。 |
| D04 | `webviewManager.ts` navigate | P0 | 先 `setHead` 再 apply，失败不回滚 | 所有导航走 `HistoryController.navigateToNode` 单一路径。 |
| D05 | `webviewManager.ts` diff URI | P0 | 完整文档内容放入 URI query | `DiffContentRegistry` 用随机 id 映射内容，URI 不含正文。 |
| D06 | `lcs.ts:86-95` | P0 | `deserializeDiff` 只校验数组，不校验 op 字段 | `DiffOperation` schema/type guard，非法 op 全拒绝。 |
| D07 | `changeTracker.ts:115-118` | P0 | processing 重入直接 return，pending 可能丢失 | `DocumentTaskQueue` 替代 processing flag。 |
| D08 | `webviewManager.ts:452-486` | P1 | Webview message 无 schema 校验 | 所有 message 使用 type guard 和未知命令忽略。 |
| D09 | `webview.html:5` | P1 | CSP 允许 `unsafe-inline` style | nonce/CSP 收紧；禁止动态 HTML 注入。 |
| D10 | `webviewManager.ts` title | P1 | HTML title 未 escape | HTML escape；模板注入只允许 text。 |
| D11 | `extension.ts:34-40` | P1 | 配置运行时未 clamp | `ConfigService` 统一读取、校验、默认值、动态更新。 |
| D12 | `lcs.ts:179-256` | P1 | 使用 `indexOf(op)` 分组，最坏 O(n²) | index-based loop。 |
| D13 | `extension.ts:71-72` | P1 | `Math.max(...largeArray)` 大量文档可能 RangeError | 循环计算 max timestamp。 |
| D14 | `package-lock.json` | P1 | lock 根版本与 package 版本不一致 | W1 恢复 toolchain 时统一。 |

---

## 5. 最终目标架构

### 5.1 模块目录

```text
src/
  extension.ts
  config/
    defaults.ts
    schema.ts
    configService.ts
  history/
    ids.ts
    events.ts
    projection.ts
    historyDocument.ts
    historyRegistry.ts
    historyController.ts
    contentStore.ts
    diffEngine.ts
    diffSchema.ts
    mergeEngine.ts
    pruningEngine.ts
    operationPreview.ts
    persistenceStore.ts
    legacyCtrlZTreeAdapter.ts
  concurrency/
    documentTaskQueue.ts
    applyEditTokens.ts
    requestScheduler.ts
    cancellation.ts
  commands/
    historyCommands.ts
    aiCommands.ts
    persistenceCommands.ts
    commandRegistration.ts
  ui/
    historyTreeProvider.ts
    suggestionsTreeProvider.ts
    hoverProvider.ts
    statusBar.ts
    quickPickBranches.ts
    confirmDialogs.ts
    diffContentRegistry.ts
    graphWebview/
      graphPanel.ts
      graphProtocol.ts
      graphRenderer.ts
      graph.html
      graph.js
      graph.css
  ai/
    types.ts
    promptBuilder.ts
    redactor.ts
    operationPlanner.ts
    secretStore.ts
    audit.ts
    providers/
      base.ts
      openaiResponsesProvider.ts
      openaiChatCompatibleProvider.ts
      anthropicMessagesProvider.ts
      customHttpJsonProvider.ts
      registry.ts
  tests/
    unit/
    integration/
    contract/
    perf/
    security/
    fixtures/
```

### 5.2 分层依赖

```text
VS Code Commands/UI
  -> HistoryController / AiCommandController / PersistenceController
    -> DocumentTaskQueue / RequestScheduler
      -> HistoryDocument / Projection / ContentStore / OperationPlanner
        -> DiffEngine / DiffSchema / ConfigService / SecretStore
```

依赖方向只允许从外层到内层。`history/projection.ts`、`diffEngine.ts`、`diffSchema.ts`、`pruningEngine.ts` 必须不依赖 VS Code API。

### 5.3 核心原则

| 原则 | 设计要求 |
|---|---|
| 写路径单一 | 所有改变文档或历史状态的操作必须走 `HistoryController`，禁止 UI handler 直接改 projection 或 Map。 |
| 事件不可变 | 已提交事件 append-only；修正通过新事件表达。 |
| 投影纯函数 | `project(events)` 可重复、可测试、无外部副作用。 |
| 内容与拓扑分离 | 拓扑由 NodeId/parent/children 表达，内容由 ContentStore 和 ContentRef 表达。 |
| UI 只订阅 | TreeView/Webview 从 projection snapshot 渲染，不持有业务状态。 |
| AI 不越权 | Provider 只返回文本/JSON；OperationPlanner 校验后才变成可执行 plan。 |
| 所有副作用可 Mock | VS Code、时间、随机数、文件系统、网络、SecretStorage、timer 均通过接口注入。 |

---

## 6. 历史数据模型

### 6.1 ID 与指纹

```ts
export type DocId = string;       // sha256(workspaceFolder + "\n" + docUri).slice(0, 24)
export type NodeId = number;      // per-document monotonic integer
export type EventSeq = number;    // per-document monotonic sequence
export type TxId = string;        // random UUID or monotonic transaction id
export type ContentHash = string; // sha256(content), never salted

export interface Cursor {
  line: number;
  character: number;
}
```

| 决策 | 说明 |
|---|---|
| `NodeId` 是唯一节点身份 | 不使用 hash、short hash、文件名、时间戳作为主键。 |
| `ContentHash` 只作内容指纹 | 相同内容可被多个节点引用；hash 不承担拓扑唯一性。 |
| Webview/TreeView item id | 使用 `${docId}:${nodeId}`。 |
| 外部展示 | 用户可看到短 node label，如 `#42`，但内部永远使用完整 NodeId。 |
| hash 校验异常 | 若 contentHash 相同但内容不等，记录 corruption error，生成新 NodeId，不修改 hash 算法。 |

### 6.2 事件类型

```ts
export type HistoryEvent =
  | InitEvent
  | EditEvent
  | HeadMoveEvent
  | RenameEvent
  | SummarizeEvent
  | ProtectEvent
  | MergeEvent
  | PruneEvent
  | ArchiveEvent
  | DeleteEvent
  | ResetEvent
  | PersistenceEvent;

export interface EventBase {
  schemaVersion: 1;
  seq: EventSeq;
  at: number;
  txId: TxId;
  source: 'user' | 'system' | 'ai-plan' | 'migration';
}

export interface InitEvent extends EventBase {
  kind: 'init';
  nodeId: NodeId;
  contentRef: ContentRef;
  contentHash: ContentHash;
  isNonEmpty: boolean;
  fileSig: FileSignature;
}

export interface EditEvent extends EventBase {
  kind: 'edit';
  nodeId: NodeId;
  parentId: NodeId;
  contentRef: ContentRef;
  contentHash: ContentHash;
  cursor?: Cursor;
  isNonEmpty: boolean;
  stats: {
    contentBytes: number;
    diffBytes: number;
    lineCount: number;
  };
}

export interface HeadMoveEvent extends EventBase {
  kind: 'headMove';
  from: NodeId;
  to: NodeId;
  reason: 'undo' | 'redo' | 'checkout' | 'restore' | 'ai-operation';
}

export interface RenameEvent extends EventBase {
  kind: 'rename';
  nodeId: NodeId;
  name: string;
  ai?: AiProvenance;
}

export interface SummarizeEvent extends EventBase {
  kind: 'summarize';
  nodeId: NodeId;
  summary: string;
  ai?: AiProvenance;
}

export interface ProtectEvent extends EventBase {
  kind: 'protect';
  nodeId: NodeId;
  protected: boolean;
  reason?: string;
}

export interface MergeEvent extends EventBase {
  kind: 'merge';
  sourceIds: NodeId[];
  resultId: NodeId;
  parentId: NodeId;
  contentRef: ContentRef;
  contentHash: ContentHash;
  archivedSourceIds: NodeId[];
  reason: string;
}

export interface PruneEvent extends EventBase {
  kind: 'prune';
  strategy: string;
  archivedIds: NodeId[];
  deletedIds: NodeId[];
  estimatedBytesFreed: number;
  warnings: string[];
}

export interface ArchiveEvent extends EventBase {
  kind: 'archive';
  nodeIds: NodeId[];
  reason: string;
}

export interface DeleteEvent extends EventBase {
  kind: 'delete';
  nodeIds: NodeId[];
  mode: 'soft' | 'hard';
  reason: string;
}

export interface ResetEvent extends EventBase {
  kind: 'reset';
  previousHeadId: NodeId;
  newRootId: NodeId;
  reason: string;
}
```

### 6.3 Projection

```ts
export interface Projection {
  docId: DocId;
  rootId: NodeId;
  headId: NodeId;
  byId: Map<NodeId, NodeView>;
  childrenOf: Map<NodeId, NodeId[]>;
  parentOf: Map<NodeId, NodeId | null>;
  branchTips: NodeId[];
  namedNodes: NodeId[];
  protectedNodes: Set<NodeId>;
  archivedNodes: Set<NodeId>;
  deletedNodes: Set<NodeId>;
  contentHashIndex: Map<ContentHash, NodeId[]>;
  lastSeq: EventSeq;
  stats: ProjectionStats;
}
```

关键不变量：

| 不变量 | 测试方式 |
|---|---|
| head 必须存在且未 hard deleted | property test + unit。 |
| root 必须存在且无 parent | property test。 |
| 每个可见非 root 节点都有 parent | property test。 |
| `childrenOf` 与 `parentOf` 双向一致 | property test。 |
| deleted 节点不出现在默认 TreeView | UI unit/integration。 |
| archived 节点可恢复，但不参与默认 branch tips | unit/integration。 |
| protected/head/current path 不会被自动 hard delete | pruning tests。 |
| `contentHashIndex` 不承担唯一性 | unit。 |

### 6.4 ContentStore

```ts
export type ContentRef =
  | { kind: 'inline-diff'; nodeId: NodeId; bytes: number }
  | { kind: 'snapshot'; snapshotId: number; bytes: number }
  | { kind: 'external'; ref: string; bytes: number };

export interface SnapshotPolicy {
  snapshotEveryNodes: number;
  snapshotInlineThresholdBytes: number;
  maxDiffDocumentBytes: number;
  maxContentBytesTracked: number;
}

export interface ContentStore {
  appendEdit(parentContent: string, nextContent: string, nodeId: NodeId, policy: SnapshotPolicy): ContentRef;
  resolve(nodeId: NodeId, projection: Projection): string;
  tryResolve(nodeId: NodeId, projection: Projection): { ok: true; content: string } | { ok: false; error: Error };
  hasSnapshot(nodeId: NodeId): boolean;
  clearCacheFor(nodeId: NodeId): void;
  compact(projection: Projection, policy: CompactionPolicy): Promise<CompactionResult>;
}
```

策略：

| 场景 | 行为 |
|---|---|
| 小 diff | 保存 inline diff，必须通过 strict schema。 |
| diff 大于阈值 | 保存 snapshot。 |
| 每 N 节点 | 强制 snapshot。 |
| 超大文档 | snapshot-only 或禁用跟踪，按配置提示用户。 |
| 高频 head 恢复 | LRU 缓存 head、parent、selected nodes。 |
| AI 摘要 | 默认只读 diff summary，不读全文。 |

---

## 7. 历史操作：最大备份、合并、删除、剪枝

### 7.1 备份定义

| 名称 | 含义 | 控制项 |
|---|---|---|
| active node | 默认可见历史节点 | `history.maxNodesPerDocument` |
| snapshot | 可直接恢复的完整内容 | `history.snapshotEveryNodes`、`history.snapshotInlineThresholdBytes` |
| archived node | 被隐藏但可恢复节点 | `pruning.archiveBeforeDelete` |
| persisted backup | 落盘历史包 | `persistence.mode`、`persistence.maxBytesPerDocument` |
| branch tip backup | 分支保留点 | `pruning.keepBranchTips` |
| protected backup | 用户/AI 标记的关键节点 | `protect` event |

### 7.2 Operation Plan

所有合并、删除、剪枝先生成 plan：

```ts
export interface HistoryOperationPlan {
  version: '1';
  docId: DocId;
  baseSeq: EventSeq;
  operation: 'merge' | 'delete' | 'archive' | 'prune' | 'rename' | 'summarize';
  targetIds: NodeId[];
  preview: OperationPreview;
  risk: 'low' | 'medium' | 'high';
  requiresConfirmation: boolean;
  generatedBy: 'user' | 'system' | 'ai';
  warnings: string[];
}
```

执行前校验：

| 校验 | 规则 |
|---|---|
| baseSeq | plan 生成后 projection 已变化则拒绝执行，要求重新生成。 |
| targetIds | 必须全部存在且未 hard deleted。 |
| head | 删除/合并不得破坏 head 可恢复性。 |
| protected | protected/named 节点默认不可删，需二次确认或先解除保护。 |
| graph invariant | 执行后 parent/children、branch tips、content refs 必须一致。 |
| preview | 用户确认时展示影响节点、释放空间、恢复方式。 |

### 7.3 合并策略

| 合并类型 | 条件 | 结果 | 默认 | 风险控制 |
|---|---|---|---|---|
| typing burst merge | 同一路径、无分叉、时间间隔短、光标接近 | 生成 result 节点，源节点 archive | 可自动 | 源节点可恢复；测试内容等价。 |
| whitespace merge | 只含空白变化 | 合并为空白 checkpoint 或归档 | 剪枝时启用 | 可配置关闭。 |
| branch squash | 选中连续线性链 | result 接到链起点 parent | 手动 | 必须预览 diff。 |
| AI proposed merge | AI 只给 plan | 用户确认后执行 | 手动确认 | stale/risk 校验。 |

### 7.4 删除策略

| 删除类型 | 默认允许 | 规则 |
|---|---|---|
| delete leaf | 是 | 非 head、非 protected、无 visible children。 |
| delete branch | 是，需确认 | 从 tip 删除到最近共享祖先，不含共享祖先。 |
| delete current head | 否 | 必须先 checkout 到其他节点。 |
| delete protected/named | 否 | 必须先 unprotect 或二次确认。 |
| archive node | 是 | 默认删除行为实际是 archive。 |
| hard delete archived | 是，需二次确认 | 释放磁盘/内存，不可恢复。 |
| AI delete | 只生成 plan | 永远需要人工确认。 |

### 7.5 剪枝策略

默认策略：`preserve-head-path-recent-branches`。

保留优先级：

1. 当前 head 到 root 的完整路径。
2. protected、named、AI high-confidence 节点。
3. 最近 `keepBranchTips` 个分支叶子。
4. 每个活跃分支至少一个 checkpoint。
5. 最近时间窗口内节点。
6. 低价值中间节点 archive。
7. 已 archive 且超过保留期的节点才允许 hard delete。

```ts
export interface PrunePlan {
  keep: NodeId[];
  archive: NodeId[];
  delete: NodeId[];
  estimatedBytesFreed: number;
  warnings: string[];
  requiresConfirmation: boolean;
}
```

自动剪枝只允许 archive。hard delete 必须由用户在预览中二次确认。

---

## 8. 并发、一致性与事务

### 8.1 事实判断

VS Code 扩展运行在 JS 事件循环中，主要风险不是多 OS 线程同时写内存，而是 async 任务交错：编辑事件、防抖 timer、undo/redo、Webview navigate、文档关闭、持久化 flush、AI 请求返回顺序互相打架。

### 8.2 DocumentTaskQueue

```ts
export class DocumentTaskQueue {
  enqueue<T>(docId: DocId, label: string, task: (token: CancellationToken) => Promise<T>): Promise<T>;
  drain(docId: DocId): Promise<void>;
  cancelPending(docId: DocId, reason: string): void;
  getPendingCount(docId: DocId): number;
}
```

规则：

| 规则 | 说明 |
|---|---|
| 单文档 FIFO | 同一 docId 的写任务串行执行。 |
| 跨文档并行 | 不同 docId 可并行。 |
| 禁止嵌套 enqueue | 同 doc task 内再 enqueue 同 doc 视为错误。 |
| 关闭文档 | cancel pending，当前任务通过 token 尽快停止。 |
| 队列上限 | 超过 `concurrency.documentQueueLimit` 后拒绝新任务并提示。 |

### 8.3 ApplyEditTokenSet

替代全局 boolean `isApplyingEdit`：

```ts
export interface ApplyEditToken {
  id: string;
  docId: DocId;
  reason: 'undo' | 'redo' | 'checkout' | 'navigate' | 'reset';
}

export class ApplyEditTokenSet {
  begin(docId: DocId, reason: ApplyEditToken['reason']): ApplyEditToken;
  end(token: ApplyEditToken): void;
  isApplying(docId: DocId): boolean;
}
```

目标：嵌套 apply、并发文档 apply、异常 finally 都不会误吞正常用户编辑。

### 8.4 applyEditAndVerify

```ts
export async function applyEditAndVerify(args: {
  document: vscode.TextDocument;
  targetContent: string;
  cursor?: Cursor;
  reason: ApplyEditToken['reason'];
  deps: EditorApplyDeps;
}): Promise<{ ok: true } | { ok: false; error: Error }>;
```

规则：

| 规则 | 说明 |
|---|---|
| apply 前 | 记录文档版本和原始内容。 |
| apply 中 | 使用 ApplyEditTokenSet 标记自触发变更。 |
| apply 返回 false | 视为失败，不提交 headMove。 |
| apply reject | 捕获，恢复 token，不提交 headMove。 |
| apply 后 | 验证 `document.getText() === targetContent`，否则失败。 |
| cursor | clamp 到目标文档范围。 |

### 8.5 RequestScheduler

```ts
export interface RequestScheduler {
  schedule<T>(req: ScheduledAiRequest<T>): Promise<T>;
  cancelByDoc(docId: DocId, reason: string): void;
  getStats(): SchedulerStats;
}
```

AI 请求约束：

| 项 | 默认 |
|---|---|
| maxConcurrentRequests | 1 |
| maxRequestsPerHour | 30 |
| timeoutMs | 15000 |
| maxRetries | 2 |
| retry status | 429、5xx、网络超时 |
| destructive plan parallel tools | 禁止 |
| cancellation | 文档关闭、用户取消、配置禁用 AI 时 abort |

---

## 9. 配置系统

### 9.1 分层

| 层级 | 面向用户 | 示例 |
|---|---|---|
| Basic | 设置页默认可见 | max nodes、persistence、AI enabled、provider、model、并发上限。 |
| Advanced | description 标注 `[Advanced]` | snapshot、diff 阈值、queue、graph render limit、retry。 |
| Internal constants | 不进设置页 | schemaVersion、event kind、hard cap、测试 hook。 |

### 9.2 最终配置清单

| 配置项 | 默认 | 范围/枚举 | 层级 |
|---|---:|---|---|
| `ctrlztree.history.maxNodesPerDocument` | 1000 | 50-100000 | Basic |
| `ctrlztree.history.maxTrackedDocuments` | 100 | 1-10000 | Basic |
| `ctrlztree.history.snapshotEveryNodes` | 32 | 1-1000 | Advanced |
| `ctrlztree.history.snapshotInlineThresholdBytes` | 8192 | 256-1048576 | Advanced |
| `ctrlztree.history.maxDiffDocumentBytes` | 4194304 | 65536-104857600 | Advanced |
| `ctrlztree.history.maxContentBytesTracked` | 10485760 | 65536-104857600 | Advanced |
| `ctrlztree.history.mergeTypingDelayMs` | 500 | 0-10000 | Basic |
| `ctrlztree.history.mergeWhitespaceDelayMs` | 500 | 0-10000 | Advanced |
| `ctrlztree.history.pauseThresholdMs` | 1500 | 50-60000 | Advanced |
| `ctrlztree.history.maxCursorLineDelta` | 1 | 0-100 | Advanced |
| `ctrlztree.history.maxCursorCharDeltaSameLine` | 20 | 0-10000 | Advanced |
| `ctrlztree.history.maxCursorCharDeltaAdjacentLine` | 10 | 0-10000 | Advanced |
| `ctrlztree.pruning.enabled` | true | boolean | Basic |
| `ctrlztree.pruning.strategy` | `preserve-head-path-recent-branches` | enum | Basic |
| `ctrlztree.pruning.targetRatio` | 0.9 | 0.1-1 | Advanced |
| `ctrlztree.pruning.keepBranchTips` | 20 | 0-10000 | Advanced |
| `ctrlztree.pruning.archiveBeforeDelete` | true | fixed true in production | Basic |
| `ctrlztree.persistence.mode` | `ask` | `off`/`ask`/`on` | Basic |
| `ctrlztree.persistence.encryption` | `aes-gcm-256` | fixed `aes-gcm-256`; no plaintext production mode | Basic |
| `ctrlztree.persistence.maxBytesPerDocument` | 8388608 | 65536-268435456 | Advanced |
| `ctrlztree.persistence.maxTotalBytes` | 134217728 | 1048576-10737418240 | Advanced |
| `ctrlztree.view.mode` | `treeViewWithGraph` | `treeView`/`treeViewWithGraph` | Basic |
| `ctrlztree.view.maxRenderedGraphNodes` | 300 | 50-5000 | Advanced |
| `ctrlztree.view.graphEngine` | `auto` | `auto`/`vis-network`/`svg-dag`/`canvas` | Advanced |
| `ctrlztree.ai.enabled` | false | boolean | Basic |
| `ctrlztree.ai.provider` | `openai-responses` | `openai-responses`/`openai-chat-compatible`/`anthropic-messages`/`custom-http-json` | Basic |
| `ctrlztree.ai.autonomy` | `L0` | `L0`/`L1`/`L2`/`L3`/`L4` | Basic |
| `ctrlztree.ai.model` | `""` | string | Basic |
| `ctrlztree.ai.baseUrl` | `""` | HTTPS URL or localhost HTTP for explicit local mode | Advanced |
| `ctrlztree.ai.maxConcurrentRequests` | 1 | 1-10 | Basic |
| `ctrlztree.ai.maxRequestsPerHour` | 30 | 0-10000 | Basic |
| `ctrlztree.ai.timeoutMs` | 15000 | 1000-120000 | Advanced |
| `ctrlztree.ai.maxRetries` | 2 | 0-10 | Advanced |
| `ctrlztree.ai.maxOutputTokens` | 512 | 16-8192 | Basic |
| `ctrlztree.ai.temperature` | 0.2 | 0-2 | Advanced |
| `ctrlztree.ai.topP` | 1 | 0-1 | Advanced |
| `ctrlztree.ai.sendFullContent` | `never` | `never`/`ask`/`always` | Basic |
| `ctrlztree.ai.redactionEnabled` | true | boolean | Basic |
| `ctrlztree.concurrency.documentQueueLimit` | 1000 | 10-100000 | Advanced |
| `ctrlztree.logging.level` | `info` | `error`/`warn`/`info`/`debug` | Advanced |
| `ctrlztree.logging.redactSensitiveData` | true | boolean | Basic |

### 9.3 密钥配置硬规则

API key 不作为 `settings.json` 配置项暴露。必须通过命令写入或删除：

| 命令 | 行为 |
|---|---|
| `ctrlztree.ai.setApiKey` | 要求用户输入 key，写入 `ExtensionContext.secrets`。 |
| `ctrlztree.ai.clearApiKey` | 从 SecretStorage 删除当前 provider key。 |
| `ctrlztree.ai.testConnection` | 使用当前 provider/baseUrl/model/key 测试最小请求，不记录 key。 |

生产代码不得从环境变量、settings、工作区文件、明文 JSON 中读取 API key 作为 fallback。测试夹具可注入 in-memory secret store。

### 9.4 ConfigService

```ts
export interface ConfigService {
  getSnapshot(): CtrlZTreeConfig;
  onDidChange(listener: (next: CtrlZTreeConfig, prev: CtrlZTreeConfig) => void): vscode.Disposable;
  validateRaw(raw: unknown): ConfigValidationResult;
}
```

要求：

| 要求 | 说明 |
|---|---|
| 运行时 clamp | 不只依赖 package.json schema。 |
| 非法值 fallback | NaN、负数、超范围、错误 enum 使用默认值并记录 warning。 |
| 动态生效 | view/AI/persistence/pruning 配置变更触发对应服务刷新。 |
| 可测试 | 不直接读 `workspace.getConfiguration`，通过 adapter 注入。 |

---

## 10. AI 子系统

### 10.1 能力等级

| 等级 | 行为 | 默认 |
|---|---|---|
| L0 | AI 完全关闭 | 是 |
| L1 | 手动生成名称/摘要候选，不自动写入 | 否 |
| L2 | 自动生成名称/摘要候选，用户一键应用 | 否 |
| L3 | 自动写入低风险 metadata，如 name/summary | 否 |
| L4 | 允许生成 merge/delete/prune operation plan，但执行仍需人工确认 | 否 |

V4 不允许 AI 自动执行破坏性操作。即使 L4，破坏性 plan 仍必须确认。

### 10.2 Provider 列表

| Provider | 用途 | 要求 |
|---|---|---|
| `openai-responses` | OpenAI Responses 格式或支持 Responses 的企业代理 | `baseUrl`、`model`、SecretStorage key。 |
| `openai-chat-compatible` | OpenAI Chat Completions 兼容格式，适配第三方/私有网关 | `baseUrl`、`model`、SecretStorage key。 |
| `anthropic-messages` | Claude Messages 格式或企业代理 | `baseUrl`、`model`、SecretStorage key。 |
| `custom-http-json` | 用户自定义 JSON HTTP 端点 | `baseUrl`、SecretStorage key、请求/响应 schema mapping。 |

禁止项：

| 禁止项 | 说明 |
|---|---|
| Copilot | 不接入、不探测、不推荐、不作为 fallback。 |
| `vscode.lm` | 不使用 VS Code Language Model API。 |
| 隐式模型通道 | Provider 不允许绕过用户配置的 endpoint/API key。 |
| 明文密钥 | API key 不得进入 settings、日志、Webview、持久化文件、错误消息。 |

### 10.3 统一请求

```ts
export interface UnifiedAiRequest {
  task: 'rename_node' | 'summarize_node' | 'summarize_branch' | 'propose_merge' | 'propose_prune' | 'propose_delete';
  model: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  responseSchema: JsonSchema;
  maxOutputTokens: number;
  temperature: number;
  topP: number;
  toolMode: 'none' | 'force_schema_tool';
  parallelToolCalls: boolean;
  metadata: {
    promptVersion: string;
    docFingerprint: string;
    headNodeId: NodeId;
    baseSeq: EventSeq;
  };
}
```

### 10.4 Provider 字段映射

| 统一字段 | OpenAI Responses | OpenAI Chat-compatible | Anthropic Messages | custom-http-json |
|---|---|---|---|---|
| endpoint | `/v1/responses` | `/v1/chat/completions` | `/v1/messages` | 用户配置 URL |
| system | `instructions` 或 input message | `messages` 中 system/developer | top-level `system` | 模板映射 |
| messages | `input` | `messages` | `messages` | 模板映射 |
| max output | `max_output_tokens` | `max_completion_tokens` | `max_tokens` | 映射字段 |
| JSON schema | structured output 或 text format | response_format 或 tool | single tool `input_schema` | 客户端强校验 |
| tools | `tools` | `tools` | `tools` with `input_schema` | 可选 |
| parallel tools | 仅只读任务可启用 | 仅只读任务可启用 | 破坏性任务禁用 parallel tool use | 默认禁用 |
| storage | `store: false` 如支持 | `store: false` 如支持 | 按 provider 数据策略 | 用户自管 |

### 10.5 Prompt 最小化

| 任务 | 默认上下文 |
|---|---|
| rename_node | parent diff summary、node diff summary、文件语言、邻近命名样例。 |
| summarize_node | node diff summary、少量上下文行，默认不含全文。 |
| summarize_branch | 分支节点摘要列表，超过预算采样。 |
| propose_prune | 节点 stats、age、branch relation，不含正文。 |
| propose_merge | 线性候选节点 diff summary。 |
| propose_delete | leaf/branch metadata，不含正文。 |

脱敏规则：

| 类型 | 示例 |
|---|---|
| API key/token | `Authorization: Bearer ...`、`api_key=...` |
| 密码 | `password: ...`、`DB_PASSWORD=...` |
| 私钥 | PEM private key block |
| URL query secret | `?token=...&key=...` |
| 云凭证 | AWS/GCP/Azure 常见环境变量 |

### 10.6 AI 输出契约

```json
{
  "version": "1",
  "task": "propose_prune",
  "baseSeq": 128,
  "nodeUpdates": [
    {
      "nodeId": 42,
      "name": "Extract history projection",
      "summary": "Introduces a pure projection layer for undo tree state.",
      "confidence": 0.86
    }
  ],
  "operationPlan": [
    {
      "operation": "archive",
      "targetIds": [12, 13, 14],
      "reason": "Intermediate whitespace-only edits superseded by node 15.",
      "risk": "low",
      "requiresConfirmation": true
    }
  ],
  "warnings": []
}
```

硬规则：

| 规则 | 行为 |
|---|---|
| schema invalid | 失败，不执行，不 best-effort 修复。 |
| stale `baseSeq` | 失败，提示重新生成 plan。 |
| stale node id | 失败，提示重新生成 plan。 |
| high risk | 必须确认。 |
| destructive operation | 必须确认，默认 archive 不 hard delete。 |
| provider error | 只显示安全错误，不输出 key/header/body。 |

---

## 11. UI 与 VS Code 嵌入

### 11.1 主入口

| UI | 角色 |
|---|---|
| TreeView `ctrlztree.history` | 主历史浏览、checkout、diff、rename、protect、merge/delete/prune 入口。 |
| TreeView `ctrlztree.aiSuggestions` | AI 生成的名称、摘要、操作计划。 |
| StatusBar | 当前节点、分支数、队列状态、AI/持久化状态。 |
| QuickPick | 多分支 redo、简单操作选择、确认轻量分支。 |
| Diff Editor | 节点与 parent、节点与 head、merge preview。 |
| HoverProvider | 编辑器悬停展示当前行附近历史信息，后续阶段实现。 |
| Webview Graph | 大图谱、批量选择、复杂 prune/merge 预览。 |

### 11.2 TreeView 信息架构

```text
CtrlZTree
  Current File
    Head
    Current Branch
    Branch Tips
    Named / Protected
    Archived
  AI Suggestions
    Name candidates
    Summary candidates
    Operation plans
  Diagnostics
    Queue
    Persistence
    Last error
```

### 11.3 TreeItem contextValue

| contextValue | 行为 |
|---|---|
| `ctrlztree.node.head` | checkout disabled，diff/rename/protect allowed。 |
| `ctrlztree.node.branchTip` | checkout/diff/delete branch/rename allowed。 |
| `ctrlztree.node.protected` | delete disabled，unprotect allowed。 |
| `ctrlztree.node.archived` | restore/hard delete allowed。 |
| `ctrlztree.node.aiSuggestion` | apply/dismiss/preview allowed。 |

### 11.4 Webview Graph 策略

V4 不要求第一阶段立即删除 `vis-network`，但必须先降权 Webview，建立可替换协议：

| 阶段 | 决策 |
|---|---|
| W1/W2 | 先修 Webview schema、URI、CSP、短 hash。 |
| W5 | 引入 `init`/`patch`/`select`/`diff`/`expand` graph protocol。 |
| W6 | benchmark `vis-network` vs SVG DAG vs Canvas，满足性能和 CSP 门槛后替换。 |

默认约束：

| 约束 | 默认 |
|---|---|
| 最大初始渲染节点 | 300 |
| 超限行为 | 折叠分支，只渲染 head path + branch tips |
| 物理布局 | 默认关闭 |
| retain hidden webview | false |
| message schema | 必须校验 |
| diff 内容 | 不进入 Webview payload，除非用户主动预览且内容经过 registry id 映射 |

---

## 12. 持久化与隐私

### 12.1 默认策略

| 项 | 默认 |
|---|---|
| `persistence.mode` | `ask` |
| `persistence.encryption` | `aes-gcm-256` |
| `untitled:` | 不持久化 |
| `output` / `git` / `vscode-notebook-cell` | 不跟踪 |
| Web 环境 | 自动降级为 `off` |
| SecretStorage 不可用 | 持久化和 AI key 保存均降级为 `off` |

首次启用持久化时必须说明：

1. 会保存编辑历史，可能包含源代码和密钥。
2. 强制加密，密钥存 VS Code SecretStorage。
3. 不提供生产明文落盘或普通明文导出。
4. 可以设置最大磁盘占用并随时清理。

### 12.2 文件布局

```text
<globalStorageUri>/
  ctrlztree-v2/
    manifest.json
    docs/
      <docFingerprint>/
        manifest.json
        events.ndjson.gz.enc
        snapshots/
          <snapshotId>.gz.enc
        archived/
          <timestamp>.ndjson.gz.enc
```

`docFingerprint = sha256(workspaceFolder + "\n" + docUri).slice(0, 24)`，避免直接暴露路径。

### 12.3 写入策略

| 场景 | 行为 |
|---|---|
| append event | 内存先 commit，后台 append 持久化队列。 |
| 空闲 | 5 分钟或 1000 events 做 compaction。 |
| close document | flush 对应 doc。 |
| deactivate | abort AI，flush persistence，清 timer。 |
| 外部文件变化 | fileSig 不匹配则 archive 旧 log，新建 init。 |
| 配额超限 | 先 compaction，再 archive prune，最后提示用户。 |

### 12.4 清理命令

| 命令 | 行为 |
|---|---|
| `ctrlztree.persistence.showUsage` | 显示每文档/总占用。 |
| `ctrlztree.persistence.clearDocument` | 清当前文档历史持久化。 |
| `ctrlztree.persistence.clearAll` | 二次确认后清全部。 |
| `ctrlztree.persistence.export` | 导出加密 JSON 包。 |
| `ctrlztree.persistence.import` | schema 校验后导入。 |

---

## 13. 安全架构

### 13.1 威胁模型

| 资产 | 威胁 | 防线 |
|---|---|---|
| API key | settings/log/webview/error 泄露 | SecretStorage、redaction、禁止明文 fallback。 |
| 源码内容 | AI 请求上传、持久化明文、URI 泄露 | AI 默认关闭、sendFullContent=never、强制加密、DiffContentRegistry。 |
| 历史树完整性 | AI 误删、用户误剪枝、并发错乱 | OperationPlan、确认、DocumentTaskQueue、property test。 |
| Webview | XSS、非法 message、CSP 放宽 | schema guard、HTML escape、nonce/CSP、最小 payload。 |
| 供应链 | 前端 bundle 或依赖被篡改 | npm audit、锁文件、资源 hash、减少外部大 bundle。 |
| 配置 | 手写非法配置导致数据损坏 | ConfigService clamp、warning、默认保守。 |

### 13.2 安全测试矩阵

| 编号 | 场景 | 测试方法 | 预期 |
|---|---|---|---|
| SEC-001 | API key 输入后不进 settings | 设置 key 后扫描 workspace/global settings | 不含 key。 |
| SEC-002 | 日志脱敏 | 构造 Authorization/password/private key 文本 | OutputChannel 不含敏感原文。 |
| SEC-003 | AI 请求默认关闭 | 未启用 AI 触发 rename/summarize | 无网络请求。 |
| SEC-004 | sendFullContent=never | 节点包含 secret | provider payload 只含 summary/redacted text。 |
| SEC-005 | 持久化加密 | 启用 persistence 后扫描落盘文件 | 不可直接读出源码片段。 |
| SEC-006 | SecretStorage 不可用 | Mock secrets throw/unavailable | AI 和 persistence 降级 off，不写明文。 |
| SEC-007 | diff URI 不含正文 | 打开 diff | URI query/path 不含源码内容。 |
| SEC-008 | Webview title escape | 文件名含 `<script>` | HTML 不含可执行脚本。 |
| SEC-009 | Webview message schema | payload 类型错/未知命令 | 不崩溃、不执行动作。 |
| SEC-010 | CSP | 检查 Webview HTML | 无不必要 `unsafe-inline`，script 使用 nonce/local resource。 |
| SEC-011 | AI destructive plan | AI 返回 delete/prune | 只展示 plan，必须确认。 |
| SEC-012 | custom endpoint 非 HTTPS | 配置公网 HTTP | 拒绝；localhost HTTP 可显式允许并警告。 |

---

## 14. 性能架构与门槛

### 14.1 复杂度目标

| 操作 | 目标复杂度 | 说明 |
|---|---|---|
| append edit | 接近 O(diff size)，避免全链重建 | 当前 head content cache。 |
| get head content | O(1) 或 O(snapshot distance) | LRU + snapshot。 |
| project events | O(events)，支持增量投影 | 初始化/恢复时可全量，运行时增量。 |
| prune plan | O(nodes log nodes) 或更好 | 保留优先级排序。 |
| TreeView refresh | O(visible nodes) | 懒展开，不渲染全树。 |
| Webview graph update | O(changed nodes) | patch protocol。 |

### 14.2 性能门槛

| 场景 | 目标 | 上限 | 说明 |
|---|---:|---:|---|
| 1MB 文档单字符编辑 append | < 20ms p95 | 50ms | 本地基线可微调。 |
| 1000 节点 head restore | < 30ms p95 | 80ms | LRU/snapshot 后。 |
| 10000 节点 prune plan | < 100ms p95 | 250ms | 后台可执行。 |
| TreeView refresh 1000 visible nodes | < 40ms p95 | 100ms | VS Code UI。 |
| Webview initial 300 nodes | < 100ms p95 | 250ms | 不启用物理布局。 |
| provider schema parse | < 5ms p95 | 20ms | AI 响应 JSON 校验。 |
| persistence append event | < 10ms foreground | 30ms | 加密/写入在后台队列。 |

### 14.3 性能风险与优化

| 风险 | 触发规模 | 影响 | 优化 |
|---|---|---|---|
| 深链重建 | 1000+ 节点 | undo/redo 卡顿 | snapshot + head cache + LRU。 |
| 大 diff | 1MB/10MB 文档 | CPU/内存暴涨 | snapshot-only 降级、阈值提示。 |
| TreeView 全量刷新 | 1000+ nodes | UI 卡顿 | 懒展开、局部 refresh、contextValue 缓存。 |
| Webview 大图 | 1000+ nodes | 渲染卡顿 | head path + branch tips、分页/折叠、Canvas/SVG benchmark。 |
| 加密写入 | 大 snapshot | IO 和 CPU | gzip + AES-GCM 后台队列、chunk、flush 合并。 |
| AI 并发 | 多文档批量操作 | 限流、provider 429 | RequestScheduler、cancel、backoff。 |

---

## 15. 白盒测试与自动化验收

### 15.1 测试层级

| 层级 | 覆盖对象 | 工具建议 |
|---|---|---|
| Unit | Projection、DiffEngine、DiffSchema、ContentStore、PruningEngine、ConfigService、Redactor、Provider mapper | Mocha + assert + sinon |
| Property | event log 不变量、projection 可达性、prune/merge 后拓扑 | fast-check |
| Contract | OpenAI Responses、OpenAI Chat-compatible、Anthropic Messages、custom HTTP Provider | fixture + mock fetch |
| Integration | VS Code commands、TreeView、Webview message、SecretStorage、DiffContentRegistry | `@vscode/test-electron` |
| Security | redaction、CSP、URI、encrypted persistence、message schema | unit + integration + static scan |
| Perf | diff/restore/prune/TreeView/Webview/persistence | benchmark scripts |
| E2E | 用户工作流：编辑、分支、命名、摘要、剪枝、导入导出 | VS Code automation |

### 15.2 覆盖率门槛

| 路径 | lines | branches |
|---|---:|---:|
| `src/history/**` | 90% | 85% |
| `src/concurrency/**` | 90% | 85% |
| `src/config/**` | 90% | 85% |
| `src/ai/redactor.ts` | 95% | 90% |
| `src/ai/providers/**` | 80% | 70% |
| `src/ui/diffContentRegistry.ts` | 90% | 85% |
| `src/ui/**` overall | 65% | 55% |
| 全项目 | 80% | 70% |

### 15.3 核心白盒用例矩阵

| 用例编号 | 模块 | 测试目标 | 输入/触发 | 断言点 | 优先级 |
|---|---|---|---|---|---|
| TC-V4-001 | Projection | init event 建 root/head | 空文档 init | root/head/byId/parentOf 正确 | P0 |
| TC-V4-002 | Projection | edit event 建子节点 | root -> edit | parent/children 双向一致 | P0 |
| TC-V4-003 | Projection | headMove 合法 | from/to 存在 | headId 更新，content 不变 | P0 |
| TC-V4-004 | Projection | headMove 非法 | to missing/deleted | 投影拒绝或 corruption error | P0 |
| TC-V4-005 | Projection | archive 不参与 branch tips | archive leaf | TreeView 默认不显示 archived | P0 |
| TC-V4-006 | Projection | delete 后无悬挂边 | delete branch | parent/children 无 dangling id | P0 |
| TC-V4-007 | ContentStore | 小 diff inline | `"abc"` -> `"abcd"` | resolve 等于新内容 | P0 |
| TC-V4-008 | ContentStore | 大 diff snapshot | 超阈值文本 | ContentRef=snapshot | P0 |
| TC-V4-009 | ContentStore | LRU 命中 | 连续 resolve head | 第二次不重放 diff | P1 |
| TC-V4-010 | DiffSchema | 非 JSON | `"x"` | 抛 schema error | P0 |
| TC-V4-011 | DiffSchema | op 字段非法 | `{type:"keep",position:"x"}` | 拒绝，不 silent ignore | P0 |
| TC-V4-012 | DiffEngine | Unicode/emoji | 中文/emoji 替换 | apply 后严格等于目标 | P1 |
| TC-V4-013 | DiffEngine | 大文本性能 | 2MB 中间替换 | p95 达标 | P1 |
| TC-V4-014 | HistoryController | undo 成功 | head 有 parent | apply 后提交 headMove | P0 |
| TC-V4-015 | HistoryController | undo apply false | mock applyEdit false | 不提交 headMove，提示错误 | P0 |
| TC-V4-016 | HistoryController | redo 多分支取消 | QuickPick undefined | head/content 不变 | P0 |
| TC-V4-017 | HistoryController | checkout stale node | node deleted | 拒绝并刷新 UI | P0 |
| TC-V4-018 | DocumentTaskQueue | 同 doc 串行 | 3 tasks | 执行顺序 FIFO | P0 |
| TC-V4-019 | DocumentTaskQueue | 跨 doc 并行 | A/B tasks | 不互相阻塞 | P1 |
| TC-V4-020 | DocumentTaskQueue | close cancel pending | enqueue 后 close | pending 取消，当前 token abort | P0 |
| TC-V4-021 | ApplyEditTokenSet | apply 自触发跳过 | token active + change event | 不新增历史节点 | P0 |
| TC-V4-022 | ApplyEditTokenSet | 异常 finally | apply throw | token 清理 | P0 |
| TC-V4-023 | ConfigService | 负数配置 | maxNodes=-1 | clamp 到最小值，warning | P1 |
| TC-V4-024 | ConfigService | enum 非法 | provider="x" | fallback 默认，warning | P1 |
| TC-V4-025 | PruningEngine | 不删 head path | 100 nodes max=50 | head->root 全保留 | P0 |
| TC-V4-026 | PruningEngine | protected 保留 | protect old node | 不在 delete/archive | P0 |
| TC-V4-027 | PruningEngine | archive 优先 | 超限 | 自动 plan 只有 archive | P0 |
| TC-V4-028 | MergeEngine | linear squash | 连续节点 | result content 等于最终内容 | P0 |
| TC-V4-029 | MergeEngine | 非线性拒绝 | 跨分支 sourceIds | 拒绝 plan | P0 |
| TC-V4-030 | DeleteEngine | delete head 拒绝 | target=head | 不执行，错误明确 | P0 |
| TC-V4-031 | DeleteEngine | delete branch | branch tip | 不删 shared ancestor | P0 |
| TC-V4-032 | DiffContentRegistry | diff URI 无正文 | open diff | uri 不含 content/secret | P0 |
| TC-V4-033 | Webview | message schema | malformed payload | 不崩溃、不执行 | P0 |
| TC-V4-034 | Webview | title escape | filename `<script>` | HTML escaped | P0 |
| TC-V4-035 | Webview | graph patch | add/update/remove nodes | 只更新变化节点 | P1 |
| TC-V4-036 | TreeView | contextValue | head/protected/archived | 菜单符合权限 | P1 |
| TC-V4-037 | TreeView | lazy children | 1000 nodes | 未展开不生成全量 item | P1 |
| TC-V4-038 | StatusBar | queue 状态 | pending tasks | 显示 pending/error | P2 |
| TC-V4-039 | Persistence | SecretStorage unavailable | mock secrets fail | persistence off，不写明文 | P0 |
| TC-V4-040 | Persistence | encrypted round-trip | events + snapshots | 解密后投影一致 | P0 |
| TC-V4-041 | Persistence | fileSig mismatch | 外部修改文件 | archive 旧 log，新 init | P0 |
| TC-V4-042 | Persistence | quota cleanup | 超 maxTotalBytes | compaction/archive/prune 顺序 | P1 |
| TC-V4-043 | Persistence | export | 导出包 | 加密 JSON，不含明文源码 | P0 |
| TC-V4-044 | AI SecretStore | set key | user input key | SecretStorage 有值，settings 无值 | P0 |
| TC-V4-045 | AI Redactor | token/password/private key | prompt build | payload 不含敏感原文 | P0 |
| TC-V4-046 | AI Provider | OpenAI Responses mapping | fixture request | 字段符合 provider contract | P1 |
| TC-V4-047 | AI Provider | Chat-compatible mapping | fixture request | `max_completion_tokens` 等映射正确 | P1 |
| TC-V4-048 | AI Provider | Anthropic mapping | fixture request | `max_tokens`/tools schema 正确 | P1 |
| TC-V4-049 | AI Provider | custom HTTP mapping | user schema | request/response 强校验 | P1 |
| TC-V4-050 | AI Provider | provider timeout | mock timeout | abort、错误脱敏 | P0 |
| TC-V4-051 | RequestScheduler | max concurrent | 5 requests max=2 | 同时运行不超过 2 | P0 |
| TC-V4-052 | RequestScheduler | hourly limit | 超过 quota | 拒绝并提示 | P1 |
| TC-V4-053 | AI Output | schema invalid | malformed JSON | 不执行 plan | P0 |
| TC-V4-054 | AI Output | stale baseSeq | projection changed | 拒绝 plan | P0 |
| TC-V4-055 | AI Operation | destructive plan | delete/prune | 必须确认 | P0 |
| TC-V4-056 | AI Operation | high risk | risk=high | 二次确认或拒绝 | P0 |
| TC-V4-057 | Security | no implicit provider | AI enabled no key | 无请求，提示配置 key | P0 |
| TC-V4-058 | Security | no plaintext key | scan logs/settings/webview | 不含 key | P0 |
| TC-V4-059 | Security | CSP | generated HTML | CSP 收紧，无不必要 inline | P1 |
| TC-V4-060 | Integration | edit -> undo -> redo | real VS Code doc | 文档、head、TreeView 同步 | P0 |
| TC-V4-061 | Integration | rapid typing + close | timer pending close | 无回调访问 closed doc | P0 |
| TC-V4-062 | Integration | multi document | A/B edits | 状态隔离 | P0 |
| TC-V4-063 | Integration | reset history | current doc reset | queues/timers/persistence 状态正确 | P1 |
| TC-V4-064 | Perf | TreeView 1000 visible | refresh | p95 达标 | P1 |
| TC-V4-065 | Perf | prune 10000 nodes | prune plan | p95 达标，不变量保持 | P1 |
| TC-V4-066 | Perf | persistence append | 1000 events | foreground 不阻塞 | P1 |
| TC-V4-067 | Regression | old CtrlZTree behavior | golden fixtures | 旧 undo/redo 语义不回退 | P0 |
| TC-V4-068 | Migration | legacy tree -> events | sample trees | projection 内容等价 | P0 |

### 15.4 Mock 方案

| 依赖 | 为什么 Mock | 正常数据 | 异常数据 | 验证 |
|---|---|---|---|---|
| VS Code workspace/window | 单元测试不可依赖真实 VS Code | mock doc/editor/config | applyEdit false/reject、openTextDocument reject | 调用次数、参数、状态回滚。 |
| SecretStorage | 验证密钥安全和不可用降级 | get/store/delete resolve | throw/unavailable | 不写 settings/log。 |
| fetch/HTTP | Provider contract | fixture response | 429/5xx/timeout/schema invalid | request body/header 脱敏、retry。 |
| timers | change debounce、scheduler | fake clock | close before timeout | clearTimeout/cancel。 |
| Date/random/uuid | 稳定事件序列 | deterministic values | duplicate txId | seq 单调、冲突处理。 |
| file system | persistence/template/readFile | bytes/string | EACCES/corrupt file | fallback/archive/error。 |
| Webview | message/postMessage | valid update | malformed payload/post throw | schema guard、safePostMessage。 |
| QuickPick/dialog | 用户确认路径 | selected/confirm | cancel/reject | 不执行破坏性动作。 |

---

## 16. V 模型与瀑布阶段门

### 16.1 V 模型映射

| V 模型层级 | 左侧设计产物 | 右侧验证产物 | 阶段门 |
|---|---|---|---|
| 用户需求 | 第 0-3 节目标、裁决、用户映射 | 用户验收 checklist、手工 smoke | P0 目标满足。 |
| 系统设计 | 第 5、8、10、11、12、13 节 | VS Code integration、安全测试、性能测试 | 无 P0/P1 open。 |
| 子系统设计 | History/AI/UI/Persistence/Concurrency 接口 | 契约测试、模块集成测试 | 接口冻结。 |
| 模块设计 | DiffSchema、Projection、Queue、Scheduler、Redactor | 单元测试、property test、mock provider test | 覆盖率达标。 |
| 代码实现 | TypeScript PR | compile、lint、coverage、audit | CI green。 |

### 16.2 瀑布阶段

| 阶段 | 目标 | 主要交付 | 阶段门 |
|---|---|---|---|
| W0 设计冻结 | V4 审批 | 本文、评审结论 | 用户确认 V4 作为唯一基准。 |
| W1 Toolchain + P0 安全修复 | 恢复可测试性和一致性 | compile/lint/test harness、DiffContentRegistry、message schema、ConfigService | compile/lint/unit 可运行；P0 安全用例通过。 |
| W2 一致性事务 | 统一写路径 | `HistoryController`、`DocumentTaskQueue`、`ApplyEditTokenSet`、`applyEditAndVerify` | undo/redo/navigate 失败不破坏状态。 |
| W3 事件日志地基 | 数据结构换芯第一步 | events/projection/contentStore/legacy adapter/golden tests | 旧行为 golden 通过；property tests 通过。 |
| W4 历史操作 | 最大备份、合并、删除、剪枝 | PruningEngine、MergeEngine、OperationPlan、preview | 不变量测试和 UI 确认流通过。 |
| W5 TreeView 主入口 | 深度嵌入 VS Code | TreeDataProvider、context menus、StatusBar、Diff Editor | TreeView 集成测试和性能门槛通过。 |
| W6 持久化与隐私 | 安全落盘和清理 | encrypted persistence、usage/clear/export/import | round-trip + encryption + quota tests。 |
| W7 Webview 图谱优化 | 降权且高性能 | graph protocol、patch render、CSP、engine benchmark | 300/1000 节点门槛；无 URI 泄露。 |
| W8 AI Provider | 名称、摘要、operation plan | Provider registry、PromptBuilder、Redactor、Scheduler、SecretStore | contract/security/autonomy tests。 |
| W9 并发硬化与兼容 | Remote/Web/多文档/取消 | feature detection、degrade paths、stress tests | 兼容矩阵通过。 |
| W10 发布 | 文档、迁移、版本 | README、CHANGELOG、migration notes、CI gates | 发布 checklist 全绿。 |

### 16.3 第一批 PR 顺序

| 顺序 | 任务 | 文件方向 | 验收 |
|---:|---|---|---|
| 1 | 恢复 toolchain 和测试 harness | `package.json`、`src/test` | `compile/lint/unit` 可运行。 |
| 2 | `DiffContentRegistry` | `src/ui/diffContentRegistry.ts` | URI 无正文。 |
| 3 | Webview message type guard | `src/webview` | 非法 payload 不崩。 |
| 4 | ConfigService clamp | `src/config` | 负数/极端配置 fallback。 |
| 5 | diff schema validation | `src/history/diffSchema.ts` 或 `src/lcs.ts` | 非法 op 全拒绝。 |
| 6 | `applyEditAndVerify` | `src/utils/editorState.ts` 或新 `editorApplier.ts` | apply false/reject 不提交 head。 |
| 7 | `ApplyEditTokenSet` | `src/concurrency` | 嵌套 apply 不误吞。 |
| 8 | baseline perf scripts | `tests/perf` | 输出 baseline markdown。 |

---

## 17. 兼容与迁移

| 场景 | 策略 |
|---|---|
| 当前内存树迁移 | `legacyCtrlZTreeAdapter` 将旧节点序列转换为 event log，golden 验证内容等价。 |
| 旧用户无持久化数据 | 无迁移；打开文档重新 init。 |
| 未来持久化 schema 升级 | manifest 记录 schemaVersion；提供 migration function；失败时 archive 原文件。 |
| VS Code 低版本 | 核心能力尽量保留；新 UI/API feature detect；不可用时禁用对应功能并提示。 |
| Web 环境 | persistence/SecretStorage 不可用时 AI 和持久化 off；TreeView 核心可保留。 |
| Remote/WSL | SecretStorage 和 globalStorage 行为需集成测试；不写明文 fallback。 |
| 特殊 scheme | `untitled` 可内存跟踪但不持久化；`output/git/vscode-notebook-cell/ctrlztree-diff` 默认不跟踪。 |

---

## 18. 决策冻结表

| 问题 | 最终决策 |
|---|---|
| 是否采用事件日志 | 是，分阶段迁移。 |
| 是否继续用 hash 作为节点 id | 否，NodeId 替代；contentHash 只做指纹。 |
| 是否保留 OpenAI Chat-compatible | 是，作为兼容层。 |
| 是否支持 Claude Messages | 是，官方 Provider。 |
| 是否支持自定义 HTTP JSON | 是，显式配置 schema mapping。 |
| 是否支持 Copilot / `vscode.lm` | 否。明确禁止接入，不作为 fallback。 |
| AI 是否默认启用 | 否。 |
| AI 是否可自动删除/剪枝 | 否，必须确认。 |
| 持久化默认 | ask。 |
| 持久化加密 | 启用后强制 AES-GCM；生产功能不提供明文退出选项。 |
| API key 存储 | 只存 VS Code SecretStorage。 |
| 是否立刻删除 vis-network | 否，先降权和 benchmark；满足门槛后替换。 |
| 主 UI | TreeView。 |
| 并发模型 | DocumentTaskQueue + ApplyEditTokenSet + RequestScheduler。 |
| 最低 VS Code 版本 | 尽量保持当前；新 API feature-detect；若必须提升，单独评审。 |

---

## 19. 风险清单

| 编号 | 风险/缺陷 | 严重程度 | 影响范围 | 触发条件 | 建议修复/缓解 | 是否必须修复 |
|---|---|---|---|---|---|---|
| R01 | 事件日志换芯导致 undo/redo 回归 | 高 | 核心功能 | W3 迁移 | legacy adapter + golden tests + 分阶段切流 | 是 |
| R02 | applyEdit 失败造成树头与文档不一致 | 高 | undo/redo/navigate | applyEdit false/reject | `applyEditAndVerify` + 事务提交 | 是 |
| R03 | 剪枝误删 redo 分支 | 高 | 历史恢复 | 超 max nodes | PrunePlan + archive 优先 + property test | 是 |
| R04 | API key 泄露 | 高 | 用户安全 | 日志/settings/error/webview | SecretStorage + redaction + scan tests | 是 |
| R05 | 源码持久化泄露 | 高 | 用户隐私 | persistence on | 强制 AES-GCM + no plaintext export | 是 |
| R06 | AI 上传敏感内容 | 高 | 用户隐私 | AI enabled | 默认 off、sendFullContent=never、redaction、审计 | 是 |
| R07 | AI 误删/误剪枝 | 高 | 历史数据 | L4 plan | 只生成 plan，确认后执行，archive 优先 | 是 |
| R08 | Webview XSS/message 注入 | 高 | Webview 安全 | 恶意文件名/payload | HTML escape、schema guard、CSP | 是 |
| R09 | Diff schema 弱导致数据损坏 | 高 | 内容恢复 | corrupt diff | strict schema + invalid fixture | 是 |
| R10 | DocumentTaskQueue 死锁或饥饿 | 中 | 多文档编辑 | 嵌套 enqueue | 禁止嵌套、检测、timeout/stats | 是 |
| R11 | 大文件仍慢 | 中 | 性能 | 10MB 文档 | snapshot-only 降级、大小阈值、提示 | 是 |
| R12 | TreeView 大量节点卡顿 | 中 | UI | 1000+ visible nodes | 懒展开、局部 refresh、benchmark | 是 |
| R13 | Webview 替换引擎回归 | 中 | 图谱 UI | W7 | 先协议后替换，benchmark 决策 | 否 |
| R14 | Provider 字段变化 | 中 | AI | API 漂移 | contract fixture、capability registry、文档链接 | 是 |
| R15 | Chat-compatible 端点差异 | 中 | AI 兼容 | 私有网关 | 只发通用字段，unsupported 按 capability 省略 | 是 |
| R16 | SecretStorage 在 Remote/Web 差异 | 中 | AI/持久化 | Remote/Web/WSL | feature detection；不可用则禁用，不写明文 | 是 |
| R17 | 配置过多影响体验 | 中 | UX | 设置页拥挤 | Basic/Advanced 分层 | 否 |
| R18 | package-lock 版本不一致 | 中 | 发布/CI | npm install/test | W1 统一 lock | 是 |
| R19 | 测试 harness 不可用 | 高 | 全部质量门 | node_modules 缺失 | W1 恢复 compile/lint/test | 是 |
| R20 | 性能优化过度复杂 | 中 | 可维护性 | 过早重构 | benchmark 驱动，不达标再替换 | 否 |

---

## 20. CI 与质量门

### 20.1 推荐脚本

| 脚本 | 目标 |
|---|---|
| `npm run compile` | TypeScript 编译。 |
| `npm run lint` | ESLint 静态检查。 |
| `npm run test:unit` | 纯单元测试。 |
| `npm run test:integration` | VS Code integration。 |
| `npm run test:contract` | AI provider fixture。 |
| `npm run test:security` | redaction/CSP/URI/encryption。 |
| `npm run test:perf` | 本机 benchmark，输出 markdown。 |
| `npm run coverage` | 覆盖率报告。 |
| `npm audit` | 依赖漏洞扫描。 |

### 20.2 CI 阶段

| 阶段 | 必跑 |
|---|---|
| PR fast | compile、lint、unit、contract、security quick。 |
| PR full | integration、coverage、perf smoke。 |
| main nightly | full perf、e2e、dependency audit。 |
| release | package、install smoke、migration smoke、manual UI checklist。 |

### 20.3 命名规范

| 类型 | 命名 |
|---|---|
| 单元测试 | `*.unit.test.ts` |
| 契约测试 | `*.contract.test.ts` |
| 集成测试 | `*.integration.test.ts` |
| 性能测试 | `*.perf.test.ts` |
| 安全测试 | `*.security.test.ts` |
| fixture | `tests/fixtures/<module>/<case>.json` |

---

## 21. 验收清单

| 验收项 | 通过标准 |
|---|---|
| 旧行为不回退 | Golden tests 覆盖当前 undo/redo/branch/diff 行为并通过。 |
| P0 缺陷关闭 | D01-D07 均有代码修复和回归测试。 |
| 密钥安全 | settings/log/webview/persistence/error 全部扫描无 API key。 |
| 持久化安全 | 落盘文件加密，SecretStorage 不可用时不写明文。 |
| AI 可控 | 默认关闭；启用需 key/baseUrl/model；破坏性 plan 必须确认。 |
| Provider 兼容 | 四类 provider contract fixture 通过。 |
| 性能达标 | 第 14 节门槛达成或有明确降级策略。 |
| TreeView 可用 | 主历史浏览、diff、checkout、rename、protect、archive 操作可用。 |
| Webview 安全 | schema/CSP/URI/escape 测试通过。 |
| 并发可靠 | 快速输入、关闭文档、undo/redo、AI 返回、flush 不冲突。 |
| 可配置 | 所有 Basic/Advanced 配置 clamp 和动态更新测试通过。 |
| 发布准备 | README/CHANGELOG/migration notes 完整。 |

---

## 22. 结语

V4 的最终方向是把 CtrlZTree 从“可用的本地 undo tree 扩展”升级为“可验证、可恢复、可审计、可配置、可安全使用 AI 的历史系统”。

核心升级不是单点功能堆叠，而是五个地基同时成立：

1. 事件日志 + 纯投影，解决历史正确性和可测试性。
2. ContentStore + snapshot/diff/LRU，解决性能和持久化。
3. DocumentTaskQueue + ApplyEditTokenSet + RequestScheduler，解决 async 竞态和 AI 并发。
4. TreeView 主入口 + Webview 降权，解决 VS Code 嵌入感和大图性能。
5. SecretStorage + 强制加密 + AI plan 审批，解决密钥、源码和历史隐私底线。

后续实现必须按阶段门推进。任何跳过 W1/W2 直接做 AI、直接大规模替换 UI、直接把持久化落盘、或引入隐式模型通道的做法，都应视为高风险并阻止合并。
