# CtrlZTree V4 功能验收与白盒测试报告

日期：2026-04-30  
基准文档：`UPGRADE_DESIGN_PLAN-V4-CodeX.md`  
被测仓库：`ctrlztree-undotree-vscode`  
测试视角：V4 功能验收、白盒路径分析、缺陷定位、测试设计  
结论级别：高风险，建议暂停按 V4 完整能力上线
复核说明：在首版基础上已追加全仓库文件清单复核，覆盖源码、测试、配置、打包忽略规则、脚本、Webview 前端和静态资源；新增发现见第 18 节。

## 1. 总体结论

### 1.1 验收判断

当前代码已经补入不少 V4 方向模块，例如 `DocumentTaskQueue`、`ApplyEditTokenSet`、`RequestScheduler`、`HistoryController`、`Projection`、`ContentStore`、AI Provider、SecretStorage、加密持久化和 test-cli 环境。但从白盒验收看，当前实现仍不是 V4 计划的完整闭环。

核心问题不是“没有测试”，而是若干关键模块只完成了局部骨架，运行时数据流仍大量停留在 legacy `CtrlZTree` hash 模型上。V4 中最关键的 append-only event log、NodeId 身份、archive-first prune、merge/delete/prune 执行器、加密持久化恢复、TreeView 主 UI 信息架构、AI 输出 fail-closed 校验、scheduler 重试/取消模型，都存在不同程度的断点。

### 1.2 是否建议上线

不建议按 V4/W1-W9 完成态上线。当前可作为阶段性开发版继续验证，但不应宣称 V4 的 W4/W6/W7/W8/W9 验收完成。

必须阻塞的原因：

| 编号 | 阻塞原因 | 严重程度 | 影响 |
|---|---|---:|---|
| B-001 | 持久化默认自动初始化并保存，但没有 V4 要求的 `ask/off/on` 用户授权开关，且运行时没有加载恢复链路 | P0 | 隐私违背、用户误以为历史可恢复但实际不可用 |
| B-002 | 持久化只保存 events，event 内的 `ContentRef` 不包含 diff/snapshot 正文，`MemoryContentStore` 未持久化 | P0 | 即使未来加载 events，也无法重建历史内容 |
| B-003 | W4 merge/delete/prune 只有 plan 或纯函数，运行时剪枝被显式禁用，最大节点数设置不生效 | P1 | 长会话无界内存增长，V4 历史操作功能缺失 |
| B-004 | `RequestScheduler` 对 provider 返回的 `{ok:false,retryable:true}` 不重试，retry sleep 期间不可取消，且 retry 会释放并发槽 | P1 | AI 请求可靠性和限流模型不符合 V4 |
| B-005 | TreeView/Webview 仍以 hash/shortHash 为节点身份，不是 V4 `DocId:NodeId`，碰撞时节点被跳过 | P1 | 节点不可达、UI 与核心身份模型不一致 |
| B-006 | VS Code 命令集成测试仍是 sample test，`applyEditAndVerify` 真实成功/失败/回滚路径未覆盖 | P1 | 核心 undo/redo/checkout 回归难以发现 |

### 1.3 已执行验证

| 命令 | 结果 | 备注 |
|---|---|---|
| `git status --short` | 仅显示未跟踪 `.codex`、`AGENTS.md`、`IMPLEMENTATION_TODOS.md`、`UPGRADE_DESIGN_PLAN-V4-CodeX.md` | 未清理用户文件 |
| `npm run compile` | 通过 | TypeScript 编译通过 |
| `npm run lint` | 0 errors，34 warnings | warnings 主要来自 provider 协议字段命名 |
| `npm run test:list` | 通过 | test-cli 使用 `/usr/bin/code`，27 个测试文件 |
| `npm test` | 退出码 0 | 输出未展示完整 Mocha passing 明细，是可观测性缺口 |

## 2. 被测范围确认

### 2.1 被测模块范围

| 模块 | 文件 | 验收重点 |
|---|---|---|
| 扩展入口与命令 | `src/extension.ts` | 激活、命令注册、undo/redo/checkout、TreeView、AI、持久化定时器 |
| Legacy 历史树 | `src/model/ctrlZTree.ts` | hash 身份、diff 存储、重建、分支、undo/redo |
| 新历史核心 | `src/history/**` | events、projection、ContentStore、Controller、operation plans |
| 变更追踪 | `src/services/changeTracker.ts` | debounce、pendingChanges、commit、panel refresh |
| 并发模型 | `src/concurrency/**` | per-doc queue、apply token、AI scheduler |
| Webview | `src/webview/**` | message schema、short hash、diff、navigate、CSP |
| TreeView | `src/ui/historyTreeProvider.ts` | TreeItem id、contextValue、可浏览性 |
| AI | `src/ai/**` | provider mapping、SecretStorage、redaction、schema validation |
| 持久化 | `src/security/**` | AES-GCM、SecretStorage、save/load/delete |
| 配置 | `src/config/**`、`package.json` | V4 配置完整性、runtime clamp、动态更新 |
| 测试 | `src/test/suite/**` | 覆盖率、集成程度、缺口 |

### 2.2 核心业务流程

1. 文档打开：`activate()` 监听已打开文档和 `onDidOpenTextDocument`，用 `getOrCreateTree()` 创建 legacy `CtrlZTree`。
2. 文档编辑：`changeTracker` 读取 `event.document.getText()`，做 debounce，然后调用 `HistoryController.commit()` 或直接 `tree.set()`。
3. 历史保存：`HistoryController.commit()` 先改 legacy tree，再追加 event 并刷新 projection。
4. undo/redo：`extension.ts` 命令直接 peek/hash/setHead，然后 `applyEditAndVerify()` 写回文档，成功后调用 `controller.recordHeadMove()`。
5. TreeView：`HistoryTreeProvider` 从 legacy tree 渲染当前 head、parent 和 redo children。
6. Webview：`webviewManager` 把 legacy tree 转成 short hash 节点，前端点击 short hash 后再映射回 full hash。
7. 持久化：`PersistenceService.initialize()` 激活时执行，5 秒 timer 对 dirty controller 写 `events.ndjson.enc` 和 `manifest.json.enc`。
8. AI：命令读取 provider/model/baseUrl/key，通过 `AiService` 和 `RequestScheduler` 调 provider。

### 2.3 输入输出与外部依赖

| 类型 | 输入 | 输出 | 外部依赖 |
|---|---|---|---|
| 文档内容 | VS Code `TextDocument` | `WorkspaceEdit`、历史节点 | `vscode.workspace`、编辑器状态 |
| 历史事件 | legacy tree 操作 | `HistoryEvent[]`、`Projection` | 时间、crypto |
| Webview 消息 | `postMessage` payload | navigate/diff/reset/reload | Webview、Diff editor、DOM 前端 |
| 持久化 | events、manifest | encrypted files | SecretStorage、globalStorageUri、workspace.fs |
| AI 请求 | config、SecretStorage key、prompt | provider response / error | fetch、网络、AbortController |
| 配置 | VS Code settings | clamped config | `workspace.getConfiguration` |

### 2.4 关键风险点

| 风险点 | 说明 |
|---|---|
| 状态双写 | legacy tree 是实际运行状态，HistoryController/projection 是影子状态，命令绕过 controller 主路径 |
| 持久化不可恢复 | events 不包含可重建正文，loadDocument 未接入 runtime |
| 默认持久化 | V4 要求默认 `ask`，当前只要 SecretStorage 可用就自动加密落盘 |
| 队列取消不足 | `DocumentTaskQueue.clear()` 不取消当前任务，`TaskToken` 未使用 |
| AI retry 语义错误 | provider 返回错误对象时 scheduler 认为请求成功 |
| UI 身份模型不一致 | TreeView/Webview 使用 hash/shortHash，不是 V4 NodeId |
| 测试断层 | 真实 VS Code 命令、Webview、持久化恢复、AI fail-closed 缺集成测试 |

## 3. V4 阶段验收矩阵

| 阶段 | V4 目标 | 当前代码证据 | 验收结果 | 风险 |
|---|---|---|---|---|
| W1 | toolchain、diff schema、Webview guard、ConfigService、DiffContentRegistry | test-cli 可用，diff schema 有校验，Webview guard 有，DiffContentRegistry 有 | 部分通过 | CSP 仍含 `unsafe-inline`，Config 只覆盖少量旧配置 |
| W2 | HistoryController、ApplyEditTokenSet、applyEditAndVerify、队列 | 模块存在，命令仍直接操作 legacy tree | 部分通过 | 写路径没有完全收敛到 controller |
| W3 | append-only event/projection/contentStore/legacy adapter | 模块和测试存在 | 部分通过 | runtime 未用 ContentStore，events 不足以重建内容 |
| W4 | merge/delete/prune operation plan + 执行 + invariant | plan/engine 存在，merge command 提示 execution deferred | 不通过 | 运行时操作不可执行，剪枝禁用 |
| W5 | TreeView primary UI | TreeView provider 存在 | 不通过 | 信息架构不符合 V4，只显示局部 head/parent/children |
| W6 | encrypted persistence | AES-GCM 存在，timer 自动保存 | 不通过 | 默认 ask 缺失、未加载恢复、content payload 缺失 |
| W7 | graph protocol、CSP、benchmark-driven renderer | Webview 仍 full update，CSP 未收紧 | 不通过 | 未见 renderer benchmark，仍 shortHash |
| W8 | AI providers、OperationPlanner、SecretStorage、Scheduler | provider 存在，key 存 SecretStorage | 部分通过 | provider response 未统一 fail-closed，scheduler retry 有缺陷 |
| W9 | compatibility/stress hardening | 有 test-cli、部分 unit tests | 不通过 | 无压力、Remote/Web、真实命令/e2e 测试门禁 |
| W10 | release docs/migration notes | README 写 0.6.0，CHANGELOG 仍到 0.5.7 | 不通过 | 发布材料不一致 |

## 4. 模块/函数理解

| 模块名称 | 主要职责 | 输入 | 输出 | 外部依赖 | 副作用 | 关键风险点 |
|---|---|---|---|---|---|---|
| `extension.activate` | 注册命令、TreeView、Webview、AI、持久化 | ExtensionContext、VS Code state | Disposable、全局状态 | VS Code API、SecretStorage、timer | 创建 OutputChannel、注册命令、启动 5 秒持久化 timer | 激活即初始化持久化，配置读取分散 |
| `CtrlZTree` | legacy 历史树 | content、cursor | hash、content、node maps | crypto、vscode.Position | 修改 `nodes/head` | hash 仍是身份，冲突加盐，`getContent` 对非法 hash 返回空 |
| `HistoryController` | 影子 event log/projection | content、legacy tree | events/projection | DocumentTaskQueue、PersistenceService | 追加 events，改 legacy tree | undo/redo/checkout 自身仍先移动 head，命令不走这些方法 |
| `changeTracker` | 编辑 debounce 和提交 | TextDocumentChangeEvent | commit 到 tree/controller | timer、VS Code editor | pending map、timeouts、panel update | controller commit 未 await，panel refresh 可能早于 commit |
| `DocumentTaskQueue` | 同文档任务串行 | docId、task | Promise result | Promise 链 | pending map、cancel map | 无 running cancellation token，异步 nested enqueue 可能死锁 |
| `RequestScheduler` | AI 并发、限流、重试、取消 | ScheduledRequest | Promise result | AbortController、timer | 队列、统计、abort | returned provider error 不重试，retry sleep 不可取消 |
| `PersistenceService` | 加密保存/加载历史 | events、fingerprint | encrypted files/events | SecretStorage、workspace.fs | 写 global storage | 未接入加载，跳过坏行，events 不含内容 |
| `webviewManager` | 图谱面板、消息、diff、navigate | panel、tree、messages | Webview payload、diff editor | Webview、commands | panel maps、document apply | shortHash 身份，CSP 放宽，payload 含源码片段 |
| `HistoryTreeProvider` | TreeView 数据 | legacy tree | TreeItems | VS Code TreeView | UI refresh | 使用 hash id，非 V4 信息架构 |
| `AiService` | provider 调用入口 | config、request | UnifiedAiResponse/Error | SecretStorage、fetch、scheduler | logs | baseUrl 激活时固定，response 未强制 validateAiResponse |

## 5. 控制流与路径分析

| 路径编号 | 触发条件 | 执行路径 | 预期结果 | 是否需要测试 | 风险等级 |
|---|---|---|---|---|---|
| CF-001 | 启动扩展 | activate -> create PersistenceService -> initialize | 若用户未启用持久化，不应落盘 | 是 | 高 |
| CF-002 | 打开 file/untitled | onDidOpenTextDocument -> getOrCreateTree | 创建当前文档树 | 是 | 中 |
| CF-003 | 编辑普通字符 | onDidChange -> debounce 50ms -> process -> controller.commit | 新节点追加，TreeView/Webview 更新 | 是 | 高 |
| CF-004 | 编辑空白 | debounce 500ms | 合并 typing burst | 是 | 中 |
| CF-005 | 编辑换行 | 立即 processDocumentChange | 立即保存节点 | 是 | 中 |
| CF-006 | ApplyEdit 自触发变化 | editTokens.isApplying true | 跳过记录 | 是 | 高 |
| CF-007 | Ctrl+Z 可 undo | peekUndo -> setHead -> apply -> recordHeadMove | 成功写文档，失败回滚 head | 是 | 高 |
| CF-008 | Ctrl+Y 单分支 | peekRedoChildren -> applyRedoBranch | 成功到子节点 | 是 | 高 |
| CF-009 | Ctrl+Y 多分支取消 | showQuickPick returns undefined | 不移动 head | 是 | 中 |
| CF-010 | TreeView navigate | command item.nodeHash -> setHead -> apply | 成功 checkout，失败回滚 | 是 | 高 |
| CF-011 | Webview navigate | shortHash -> fullHash -> setHead -> apply | 成功切换，失败回滚 | 是 | 高 |
| CF-012 | Webview malformed message | schema guard false | 不执行动作，不崩溃 | 是 | 中 |
| CF-013 | 打开 diff | registry.register -> `ctrlztree-diff:<id>/side` | URI 不含源码 | 是 | 中 |
| CF-014 | 超过 maxHistoryNodes | getOrCreateTree warning only | V4 应 archive/prune | 是 | 高 |
| CF-015 | mergeChain 确认 | generateMergePlan -> user confirms | V4 应执行 merge event | 是 | 高 |
| CF-016 | deactivate | clear timer -> flushToDisk without await | 应可靠 flush 或明确 best-effort | 是 | 高 |
| CF-017 | AI testConnection | clamp config -> SecretStorage key -> scheduler -> provider | 成功或脱敏错误 | 是 | 高 |
| CF-018 | AI provider 429/5xx returns object | provider returns `{ok:false,retryable:true}` | 应 retry/backoff | 是 | 高 |
| CF-019 | Scheduler cancel queued | cancelByDoc | queued reject, running abort | 是 | 中 |
| CF-020 | Scheduler cancel during retry backoff | retry sleep | 应立即取消 | 是 | 高 |
| CF-021 | Persistence load corrupt line | loadDocument catches JSON line error | V4 应 fail closed/archive | 是 | 高 |
| CF-022 | TreeView large history | getChildren reconstructs content for visible nodes | 不应卡 UI | 是 | 中 |

## 6. 数据流分析

| 数据对象 | 输入来源 | 校验位置 | 转换位置 | 存储位置 | 输出位置 | 风险点 | 建议 |
|---|---|---|---|---|---|---|---|
| 文档正文 | `TextDocument.getText()` | 基本无 | `generateDiff/applyDiff` | legacy `TreeNode.diff`，持久化 events 中仅元数据 | WorkspaceEdit、Webview preview、DiffContentRegistry | 持久化 events 不含可重建正文；Webview payload 含片段 | ContentStore 必须成为 runtime source，持久化 snapshots/diffs 加密保存 |
| 节点身份 | legacy hash | `tree.setHead` 只查 Map | Webview shortHash | `nodes` Map、TreeItem.id | TreeView/Webview/commands | 不符合 V4 NodeId，shortHash 碰撞跳过节点 | runtime 改用 `DocId:NodeId`，hash 仅 content fingerprint |
| 事件日志 | HistoryController | projection diagnostics | `project()` | 内存 events、encrypted file | projection、PersistenceService | 命令直接 `recordHeadMove` 可能映射不存在 hash；events 不完整 | 所有写路径走 controller transaction |
| 配置 | VS Code settings | `clampConfig/clampAiConfig` | 局部 clamp | 无集中 snapshot | runtime services | V4 多数配置不存在，baseUrl 激活时固定 | 完整 ConfigService + onDidChange |
| API key | inputBox | provider enum 校验 | SecretStorage key | VS Code SecretStorage | provider header | set/delete 未 catch SecretStorage 不可用异常 | 命令层捕获并安全提示 |
| AI response | provider body | provider parse 只弱规范化，operationPlanner 不在 sendRequest 中调用 | normalizeResponse | 内存 | caller | invalid schema 被默认化为空数组/默认 task | sendRequest 后强制 `validateAiResponse` |
| 持久化文件 | events/projection seq | manifest 只检查 schemaVersion | encrypt gzip AES-GCM | globalStorageUri | loadDocument | 默认自动保存；坏行跳过；未恢复 | mode=ask/off/on，corrupt archive，load 接入 controller |
| Webview message | `onDidReceiveMessage` | `isWebviewIncomingMessage` | shortHash lookup | panel maps | commands/apply | shortHash 长度/格式未限制，error stack 直接显示 | 限制格式/长度，错误 payload 脱敏 |

## 7. 缺陷与风险汇总

| 编号 | 风险/缺陷 | 位置 | 严重程度 | 影响范围 | 触发条件 | 建议修复方案 | 是否必须修复 |
|---|---|---|---:|---|---|---|---|
| R-001 | 默认自动加密持久化，缺 V4 `ask/off/on` 授权 | `src/extension.ts:52-60`, `src/extension.ts:231-245`, `package.json:129-176` | P0 | 隐私、合规、用户信任 | SecretStorage 可用并产生 controller | 加入 `ctrlztree.persistence.mode`，默认 ask/off，用户确认后才写 | 是 |
| R-002 | 持久化 events 不包含可恢复内容，load 未接入 runtime | `src/history/historyController.ts:134-139`, `src/security/persistenceService.ts:42-83` | P0 | 历史恢复、数据可靠性 | 重启 VS Code 或尝试恢复历史 | 持久化 ContentStore snapshots/diffs，加密落盘，activate/getOrCreateController 加载并校验 | 是 |
| R-003 | `loadDocument` 静默跳过 malformed event line | `src/security/persistenceService.ts:104-113` | P1 | 数据完整性 | 加密文件解密后存在坏行/截断 | 任一坏行 fail closed，归档 corrupt 文件并返回错误 | 是 |
| R-004 | pruning 设置不生效，超过节点仅 warning | `src/extension.ts:106-110`, `src/model/ctrlZTree.ts:267-274` | P1 | 性能、内存、用户配置可信度 | 长时间编辑超过 max nodes | 接入 `PruningEngine` archive-first executor，自动只 archive，不 hard delete | 是 |
| R-005 | merge 命令确认后不执行 | `src/extension.ts:378-420` | P1 | W4 功能 | 用户运行 mergeChain 并确认 | 实现 MergeEvent executor、content result、archive source、projection invariant | 是 |
| R-006 | delete/prune 用户命令缺失 | `package.json:60-87`, `src/extension.ts` | P1 | W4 功能 | 用户需要删除/剪枝历史 | 增加 preview/confirm/executor 命令和 tests | 是 |
| R-007 | runtime 仍以 hash/shortHash 为身份 | `src/model/ctrlZTree.ts:101-110`, `src/webview/webviewManager.ts:353-360`, `src/ui/historyTreeProvider.ts:24-26` | P1 | 状态一致性、UI 可达性 | 同前缀 hash 碰撞或 V4 NodeId 迁移 | TreeView/Webview/commands 全改 `DocId:NodeId` | 是 |
| R-008 | `RequestScheduler` 不重试 returned provider error | `src/concurrency/requestScheduler.ts:101-109`, `src/ai/providers/base.ts:54-59` | P1 | AI 网络可靠性 | provider 捕获网络/429/5xx 后返回 `{ok:false}` | Scheduler 支持 result-level retry 或 provider 抛 structured error | 是 |
| R-009 | retry backoff 不可取消且释放并发槽 | `src/concurrency/requestScheduler.ts:113-145` | P1 | 限流、取消、并发 | 429/timeout 进入 retry sleep，随后取消或排队新请求 | retry sleep 使用 abortAwareSleep，retry attempt 保持占用或有独立 state | 是 |
| R-010 | `DocumentTaskQueue` 无运行中 cancellation token | `src/concurrency/documentTaskQueue.ts:1-75` | P1 | 文档关闭、任务泄露 | close 时 clear queue，但 running task 继续 | 实现 token 参数，running task 检查 token，close 调 cancelPending+drain | 是 |
| R-011 | 异步 nested enqueue 可死锁 | `src/concurrency/documentTaskQueue.ts:12-18` | P1 | 并发模型 | task await 后再 enqueue 同 doc 并 await | 使用 AsyncLocalStorage 或 active-running set 覆盖整个 task 生命周期 | 是 |
| R-012 | `deactivate()` 不 await flush | `src/extension.ts:700-710` | P1 | 退出数据丢失 | 有 dirty controller 时关闭扩展 | 返回 `Promise<void>` 并 await `Promise.allSettled(flushes)` | 是 |
| R-013 | `Math.max(...nodes)` 仍可能 RangeError | `src/extension.ts:124-125` | P1 | 大历史、多文档 | closed history 中节点很多 | 改循环求 max，避免 spread | 是 |
| R-014 | `changeTracker` 不 await controller.commit，UI 可能早刷 | `src/services/changeTracker.ts:149-169` | P1 | UI 一致性 | queue 有 backlog 或 commit 失败 | `await controller.commit` 后再 refresh；失败不更新 UI | 是 |
| R-015 | `HistoryController.undo/redo/checkout` 自身先移动 tree head | `src/history/historyController.ts:164-250` | P1 | 未来调用方事务安全 | 直接调用 controller undo/redo/checkout 且 apply 失败 | Controller 暴露 transactional API：resolve target -> apply -> commit headMove | 是 |
| R-016 | AI baseUrl 激活时固定，配置变化不生效 | `src/extension.ts:279-309` | P2 | AI 可用性 | 用户修改 provider/baseUrl 后 testConnection | provider 读取 request-time config 或 registry 重建 | 是 |
| R-017 | 公网 HTTP endpoint 被接受 | `src/config/configService.ts:91-110` | P1 | 安全 | `http://example.com` | HTTPS only，localhost HTTP 需显式 local mode 警告 | 是 |
| R-018 | AI response parse 默认化非法结构 | provider parsers、`src/ai/operationPlanner.ts` 未接入 | P1 | AI 安全边界 | provider 返回缺字段/错字段 | 所有 provider parse 后走 strict schema + `validateAiResponse` | 是 |
| R-019 | CSP 仍允许 `unsafe-inline` style | `src/webview/webview.html:5` | P1 | Webview XSS 防线 | 任何 style 注入或未来 HTML 动态扩展 | nonce/hash 或外部 CSS，移除 unsafe-inline | 是 |
| R-020 | TreeView 不符合 V4 主 UI 架构 | `src/ui/historyTreeProvider.ts:67-119` | P2 | 功能体验 | 多分支/命名/保护/归档节点 | 使用 projection snapshot，展示 Current File/Branch Tips/Named/Archived/Diagnostics | 否，但应修 |
| R-021 | 测试中仍有 sample test 和 smoke 假测试 | `src/test/suite/extension.test.ts:8-14`, `src/test/suite/editorApply.unit.test.ts:4-17` | P1 | 回归质量 | 核心 VS Code 命令行为变更 | 改为真实集成测试 | 是 |
| R-022 | README/CHANGELOG 版本不一致 | `README.md:80-83`, `CHANGELOG.md:5` | P2 | 发布可信度 | 打包发布 | 更新 CHANGELOG 或 README，避免声明未发布能力 | 否 |

## 8. 白盒测试用例清单

### 8.1 P0/P1 必测用例

| 用例编号 | 测试目标 | 输入数据 | 前置条件/Mock | 执行步骤 | 预期结果 | 断言点 | 覆盖路径 | 优先级 |
|---|---|---|---|---|---|---|---|---|
| WB-001 | 默认未授权不落盘 | `persistence.mode` 缺省 | mock SecretStorage available、mock globalStorage fs | activate -> 编辑文档 -> 等待 flush tick | 不创建 `ctrlztree-v2/docs` | fs.writeFile 未调用，用户未确认 | CF-001 | P0 |
| WB-002 | 开启持久化后加密保存可恢复 | 文档 `secret=abc\nv2` | SecretStorage in-memory、mock fs | commit 两次 -> flush -> 重新创建 controller load | 恢复 events 和内容到 v2 | 加密文件不含 secret，恢复 content 等于 v2 | CF-016 | P0 |
| WB-003 | event-only 持久化不可恢复回归 | events 包含 inline-diff ContentRef | 当前实现 | saveDocument -> loadDocument -> 尝试 ContentStore resolve | 应暴露失败，不应宣称成功 | 缺 snapshot/diff payload 时 fail closed | CF-021 | P0 |
| WB-004 | corrupt persisted event fail closed | 解密 NDJSON 中一行 `{bad` | mock decrypt 返回坏行 | loadDocument | 返回 ok:false 并归档/提示 | 不跳过坏行继续成功 | CF-021 | P1 |
| WB-005 | pruning 超限执行 archive | 1001 节点线性历史 | config max=1000 | commit 到超限 | 自动生成 PruneEvent archive，不 hard delete | 节点数/archivedNodes/可恢复性 | CF-014 | P1 |
| WB-006 | pruning 保留 head path | 分叉树，head path 很长 | PruningEngine executor | 超限 prune | head 到 root 全保留 | 每个 parent 可达 | CF-014 | P1 |
| WB-007 | mergeChain 确认后实际 merge | 线性 3 节点 | mock showInformationMessage 返回 Merge | 执行命令 | 新 result 节点创建，source archived | MergeEvent、projection invariant、content 等价 | CF-015 | P1 |
| WB-008 | delete head 被拒绝 | targetIds=[head] | projection fixture | generate/execute delete plan | 拒绝执行 | errors 包含 head，events 不变 | CF-015 | P1 |
| WB-009 | RequestScheduler 对 returned 429 error 重试 | provider 返回 `{ok:false,statusCode:429,retryable:true}` 两次后成功 | fake provider/fake timer | schedule request | retry 两次后成功 | execute 调用 3 次，totalRetried=2 | CF-018 | P1 |
| WB-010 | retry sleep 期间 cancel 生效 | 第一次返回 retryable，进入 backoff | fake timers | cancelByDoc | promise reject cancelled | 不再第二次 execute | CF-020 | P1 |
| WB-011 | retry 不突破 maxConcurrent | maxConcurrent=1，reqA retry sleep，reqB queued | fake timers | schedule A then B | B 不应在 A 最终完成前执行 | maxRunning <= 1 | CF-020 | P1 |
| WB-012 | DocumentTaskQueue 异步 nested enqueue 拒绝 | task await 后 enqueue same doc | queue only | enqueue outer | 立即拒绝 nested，不死锁 | promise 在超时内 reject | CF-003 | P1 |
| WB-013 | document close 取消 running commit | long commit task | mock close | enqueue long task -> close | task 收到 token cancelled | 不写 tree/persist | CF-016 | P1 |
| WB-014 | undo apply false 不移动 head | 历史 v1->v2 | mock workspace.applyEdit false | 执行 undo | 文档仍 v2，head 仍 v2 | head/content/events 无 headMove | CF-007 | P1 |
| WB-015 | redo apply reject 不移动 head | v1->v2 undo 到 v1 | mock applyEdit throw | 执行 redo | head 仍 v1 | 无 headMove event | CF-008 | P1 |
| WB-016 | TreeView checkout 失败回滚 projection | item.nodeHash target | mock apply false | navigateToNode | legacy head 和 projection head 都不变 | recordHeadMove 未调用 | CF-010 | P1 |
| WB-017 | Webview navigate 失败回滚且不刷新错误 head | shortHash target | mock apply false | post navigateToNode | head 回滚，panel update 不显示 target head | post payload headShortHash 为旧值 | CF-011 | P1 |
| WB-018 | shortHash 碰撞不丢节点 | 两节点 shortHash 相同 | mock tree.getAllNodes | postUpdatesToWebview | V4 应两个节点都有唯一 NodeId | nodes.length 等于输入节点数 | CF-011 | P1 |
| WB-019 | AI schema invalid fail closed | provider 返回 `{foo:"bar"}` | mock provider | AiService.sendRequest + validate | 返回 error，不默认 summarize_node | no nodeUpdates applied | CF-017 | P1 |
| WB-020 | 公网 HTTP baseUrl 被拒绝 | `http://example.com/api` | clampAiConfig | validate | invalid | errors 包含 HTTPS/local | CF-017 | P1 |

### 8.2 扩展集成与 UI 用例

| 用例编号 | 测试目标 | 输入数据 | 前置条件/Mock | 执行步骤 | 预期结果 | 断言点 | 覆盖路径 | 优先级 |
|---|---|---|---|---|---|---|---|---|
| WB-021 | file 文档自动建树 | 空工作区文件 | VS Code test host | openTextDocument + show | tree created | TreeView root HEAD 可见 | CF-002 | P1 |
| WB-022 | untitled 文档可跟踪但不持久化 | untitled 文档 | persistence enabled | 编辑并 flush | 不写对应 doc file | listDocuments 不含 untitled | CF-002 | P1 |
| WB-023 | output/git/diff scheme 不跟踪 | `ctrlztree-diff:` 文档 | mock event | onDidChange | 不调用 commit | historyTrees 不变 | CF-006 | P2 |
| WB-024 | 普通快速输入合并 | 输入 `abc` 间隔 < pauseThreshold | fake timer | type chars | 生成合理节点数 | 非每字符一个节点或符合策略 | CF-003 | P2 |
| WB-025 | 换行立即 flush | 输入 `\n` | fake timer | edit | 不等待 debounce | commit 立即发生 | CF-005 | P2 |
| WB-026 | 多分支 redo 取消 | v1->v2，undo，v3 分支 | showQuickPick undefined | redo | 不动 head | head before=after | CF-009 | P1 |
| WB-027 | 多分支 redo 选择 | 同上 | showQuickPick target | redo | 到选择分支 | document.getText=target | CF-009 | P1 |
| WB-028 | DiffContentRegistry URI 不含源码 | content 包含 `SECRET_X` | open diff | capture URI | URI path/query 不含 SECRET_X | provider content by id only | CF-013 | P1 |
| WB-029 | Webview malformed payload 不执行 | `{command:"navigateToNode", shortHash:123}` | fake panel | onDidReceiveMessage | ignore | handler 未调用 | CF-012 | P2 |
| WB-030 | Webview error payload 脱敏 | stack 含 token | fake output | webviewError | 日志不含 token | redactor applied | CF-012 | P1 |
| WB-031 | CSP 不允许 unsafe-inline | generated html | getWebviewContent | inspect | no unsafe-inline | CSP string | CF-012 | P1 |
| WB-032 | TreeView contextValue 权限 | head/protected/archived nodes | projection/tree fixture | getChildren | action visibility 正确 | contextValue 符合 V4 | CF-010 | P2 |

### 8.3 纯逻辑、边界与回归用例

| 用例编号 | 测试目标 | 输入数据 | 前置条件/Mock | 执行步骤 | 预期结果 | 断言点 | 覆盖路径 | 优先级 |
|---|---|---|---|---|---|---|---|---|
| WB-033 | diff add/remove/replace round-trip | `abc` -> `aXc` | none | generate/apply | 等于目标 | deep equal/strict equal | diff | P1 |
| WB-034 | invalid diff semantic order | keep/remove/add 顺序乱 | none | deserialize/apply | fail closed | throws | diff | P1 |
| WB-035 | Unicode/emoji diff | `你好` -> `你好🌍` | none | generate/apply | 不乱码 | content equal | diff | P2 |
| WB-036 | CRLF/LF apply | CRLF document target LF | VS Code document | applyEditAndVerify | normalized match | getText normalized | editorApply | P2 |
| WB-037 | `getContent(nonexistent)` 不静默成功 | fake hash | CtrlZTree | call | 应返回 Result error 或 throw | 不返回空内容 | legacy | P1 |
| WB-038 | duplicate content different parent | same content under branch | CtrlZTree | set same content on different parent | NodeId distinct，ContentHash same | projection contentHashIndex length | history | P1 |
| WB-039 | projection duplicate nodeId | duplicate edit event | project | call | diagnostic error | diagnostics | projection | P1 |
| WB-040 | projection hard delete head | delete event on head | project | call | diagnostic error | diagnostics contains head deleted | projection | P1 |
| WB-041 | ContentStore deep chain with snapshot | 100 edits | MemoryContentStore | resolve last | content correct | no null | contentStore | P1 |
| WB-042 | ContentStore missing parent snapshot | missing entry | MemoryContentStore | resolve | fail | null/error | contentStore | P2 |
| WB-043 | Redactor URL/query/headers/private key | text fixtures | none | redact | no secret remains | negative includes | security | P1 |
| WB-044 | SecretStorage unavailable | mock secrets throws | createVSCodeSecretStore | set/get/init | AI/persistence disabled | no plaintext fallback | security | P1 |
| WB-045 | Config lower/upper/NaN clamp | numeric extremes | clampConfig | call | clamp/warn | warning called | config | P2 |
| WB-046 | V4 nested config names | `history.maxNodesPerDocument` | config adapter | read | recognized | snapshot uses V4 name | config | P1 |
| WB-047 | package schema and ConfigService 对齐 | package properties | static test | compare keys | no drift | all package keys validated | config | P1 |
| WB-048 | README claims match runtime | README/CHANGELOG/package | static test | parse version/features | no impossible claim | docs gate | release | P2 |

### 8.4 性能、压力、兼容用例

| 用例编号 | 测试目标 | 输入数据 | 前置条件/Mock | 执行步骤 | 预期结果 | 断言点 | 覆盖路径 | 优先级 |
|---|---|---|---|---|---|---|---|---|
| WB-049 | 1MB 单字符编辑 p95 | 1MB 文档 | perf harness | 100 次 append | p95 < V4 门槛 | measured p50/p95 | perf | P1 |
| WB-050 | 10000 节点 prune plan | synthetic projection | perf harness | generatePrunePlan | p95 < 250ms | p95 | perf | P1 |
| WB-051 | TreeView 1000 visible nodes | large tree | VS Code test | expand | <100ms 且不卡 UI | timing | UI perf | P2 |
| WB-052 | Webview 300 nodes initial render | large tree | Playwright/VS Code host | visualize | <250ms，无空白 | screenshot/pixel | UI perf | P2 |
| WB-053 | maxTrackedDocuments 大量关闭历史 | 200 docs，每个 10000 节点 | integration | open/close docs | 不 RangeError | no crash | CF-014 | P1 |
| WB-054 | Remote/Web SecretStorage 降级 | mock env | integration | activate | safe disabled | no writes | compatibility | P1 |
| WB-055 | provider timeout | fake never resolves | fake timer | sendRequest | timeout + retry limit | final error redacted | AI | P1 |
| WB-056 | provider 401 不重试 | fake 401 | scheduler/provider | sendRequest | no retry | execute once | AI | P2 |
| WB-057 | deactivate flush waits | dirty controllers | fake persistence slow | deactivate | waits/allSettled | save called before clear | lifecycle | P1 |
| WB-058 | log no sensitive content | secret in doc/provider error | fake output | run AI/persist/error | no raw secret | output scan | security | P1 |

## 9. 边界条件测试清单

| 边界类型 | 具体值 | 覆盖模块 | 测试方法 | 优先级 |
|---|---|---|---|---|
| 数值最小 | maxHistoryNodes=0/-1/49/50 | Config/Pruning | clamp + runtime prune | P1 |
| 数值最大 | maxHistoryNodes=100000/100001，maxTracked=10000/10001 | Config/cleanup | clamp + cleanup | P2 |
| NaN/Infinity | `NaN`, `Infinity` | Config | raw config mock | P2 |
| 空字符串 | empty document、empty AI baseUrl/model | CtrlZTree/AI | open empty doc、enabled AI | P1 |
| 单字符 | `a` -> empty -> undo | diff/undo | VS Code command | P1 |
| 超长字符串 | 1MB/10MB source | diff/contentStore/Webview | perf harness | P1 |
| Unicode | 中文、emoji、combining marks | diff/persistence | round-trip | P2 |
| 特殊字符 | `<script>`, quotes, newlines, tabs | Webview/HTML/log | generated HTML/payload | P1 |
| 空集合 | no events/no children/no branch tips | projection/redo | unit | P2 |
| 单元素集合 | one child redo | CtrlZTree/command | integration | P1 |
| 多元素集合 | multiple redo branches | command/UI | QuickPick mock | P1 |
| 重复元素 | duplicate targetIds | operation plan | validation | P2 |
| 大量元素 | 10000 nodes | prune/TreeView/Webview | perf/stress | P1 |
| 时间边界 | same timestamp、old archived、future time | prune/time ago | fake Date.now | P2 |
| 状态边界 | root/head/protected/archived/deleted | projection/delete/prune | invariant tests | P1 |
| 取消边界 | queued/running/retry sleep | queues/scheduler | fake timers | P1 |

## 10. 异常路径测试矩阵

| 异常场景 | 触发方式 | 预期行为 | 是否回滚 | 是否记录日志 | 是否告警 | 测试方法 |
|---|---|---|---|---|---|---|
| `workspace.applyEdit` 返回 false | mock VS Code applyEdit false | 不移动 head，不追加 headMove | 是 | 是 | 用户短提示 | command integration |
| `workspace.applyEdit` reject | mock throw | token finally end，head 回滚 | 是 | 是 | 用户短提示 | command integration |
| `document.save` 返回 false | mock dirty initial snapshot | 不崩溃，记录清 dirty 失败 | 否 | 是 | 否 | editorState test |
| SecretStorage unavailable | secrets.get/store throw | AI/persistence disabled，无明文 fallback | 不适用 | 是 | 用户提示 | security integration |
| globalStorage fs write fail | writeFile throw | saveDocument ok:false，needsPersist 保持 true | 不适用 | 是 | 视情况 | persistence test |
| persisted manifest schema unsupported | schemaVersion=2 | fail closed | 不适用 | 是 | 是 | load test |
| malformed NDJSON event | bad JSON line | fail closed，不跳过 | 不适用 | 是 | 是 | load test |
| provider 429 | HTTP 429 body | retry with backoff+jitter，最终保留原因 | 不适用 | 是 | 否 | AI scheduler |
| provider plain text under strict schema | text response | fail closed | 不适用 | 是 | 否 | provider contract |
| Webview invalid message | wrong type/nested field | ignore，不调用 handler | 不适用 | debug/warn | 否 | message unit |
| Webview reset confirmed | user confirms | history reset，controller/persistence 同步重置 | 是 | 是 | 用户确认 | integration |
| queue task throws | task throw | 后续任务继续，pending count 清理 | 不适用 | 可选 | 否 | queue unit |
| deactivate during flush | flush slow/reject | await settled，不吞关键错误 | 不适用 | 是 | 否 | lifecycle test |

## 11. Mock 与依赖隔离方案

| 依赖 | 为什么需要 Mock | 正常数据 | 异常数据 | 调用次数/参数验证 | 超时/失败/部分成功模拟 |
|---|---|---|---|---|---|
| VS Code `workspace.applyEdit` | 核心写回副作用，不可在 unit 直接稳定控制 | returns true + document text updated | false、throw、text mismatch | assert edit range/content/reason token | promise 延迟/拒绝 |
| VS Code `TextDocument` | 控制 eol、lineCount、uri、dirty | file/untitled 文档 | diff/output/git scheme、closed doc | assert getText/lineAt called | close while task pending |
| VS Code `window` | QuickPick/Message/UI command | selected branch、confirmed Merge | undefined/cancel | assert no mutation on cancel | delayed user choice |
| WebviewPanel/Webview | 消息和 post payload | `postMessage` true | disposed panel/post false | payload nodes/edges/head | disposed during update |
| `workspace.fs` | 持久化、模板加载 | read/write encrypted bytes | FileNotFound、permission denied、partial write | file path 不含 raw doc path | write fail after data success before manifest |
| SecretStorage | key 存储和不可用降级 | get/set/delete ok | get/store throw、invalid key length | key 名按 provider/dataKey | unavailable after init |
| fetch/provider | AI 网络路径 | 200 structured JSON | 401、429、500、invalid JSON、timeout | headers 不泄露到日志；endpoint 正确 | never resolve、AbortError |
| timers | debounce、flush、retry、rate limit | fake clock advance | cancel before fire | setTimeout/setInterval count | long sleep cancel |
| Date.now/random/crypto | 时间窗口、id、IV | deterministic now | same timestamp | generated ids unique | collision fixtures |
| OutputChannel/Logger | 脱敏和可观测性 | appendLine messages | secret-bearing errors | scan output | high-volume logs |

## 12. 安全性白盒测试建议

| 风险点 | 代码位置 | 触发条件 | 影响 | 测试方法 | 修复建议 | 风险等级 |
|---|---|---|---|---|---|---|
| 默认落盘历史未询问用户 | `src/extension.ts:52-60`, `src/extension.ts:231-245` | SecretStorage 可用 | 源码/密钥片段被保存到磁盘 | activate 后检查 fs.writeFile | 默认 `persistence.mode=ask/off` | 高 |
| CSP 允许 unsafe-inline | `src/webview/webview.html:5` | Webview 打开 | XSS 防线弱 | 生成 HTML 静态断言 | 移除 unsafe-inline，使用 nonce/hash | 高 |
| 公网 HTTP AI endpoint | `src/config/configService.ts:106-110` | baseUrl 为 `http://example.com` | API key 明文传输 | clampAiConfig test | HTTPS only，localhost 特例 | 高 |
| AI response 未强 schema fail closed | provider parsers、`AiService.sendRequest` | provider 返回缺字段 JSON | AI plan 被默认化 | provider contract | parse 后调用 `validateAiResponse` | 高 |
| Webview error stack 直接日志/提示 | `src/webview/webviewManager.ts:588-590` | stack 含 token/path | 日志泄露 | payload 含 token | redaction + 限制长度 | 中 |
| TreeView/Webview payload 含源码片段 | `src/webview/webviewManager.ts:379-384`, `src/ui/historyTreeProvider.ts:79-81` | 历史含敏感代码 | Webview/TreeView 可见泄露 | secret fixture scan payload | 默认只摘要/脱敏，全文仅用户主动 diff | 中 |
| SecretStorage set/delete 未捕获 | `src/extension.ts:610-654` | SecretStorage 不可用 | 命令抛异常 | mock secrets throw | catch 并安全提示 | 中 |
| Diff provider 返回空内容掩盖非法 id | `src/extension.ts:65-78` | URI 被伪造 | 错误被静默 | forged URI test | 返回安全错误文本或 diagnostics | 低 |

## 13. 并发与一致性测试建议

| 场景 | 并发数量 | 初始数据 | 执行动作 | 预期结果 | 断言点 | 潜在问题 |
|---|---:|---|---|---|---|---|
| 同文档快速编辑 | 20 edits | empty file | 并发触发 debounce/commit | FIFO，无丢失 | final content、events seq 连续 | `controller.commit` 未 await 导致 UI 早刷 |
| 跨文档编辑 | 10 docs | each empty | 同时编辑 | docs 独立 | 每文档 head/content 正确 | 全局 state 串扰 |
| undo 与 pending commit 交错 | 1 doc | commit 队列积压 | undo while commit pending | undo 排队或拒绝，不能乱序 | final head/event order | 命令绕过 queue |
| Webview navigate 与 edit 交错 | 1 doc | v1->v2 | 用户编辑同时点击 node | 单一路径决定，不能旧内容覆盖新编辑 | document.version/head | setHead/apply 非队列化 |
| document close during commit | 1 doc | pending long task | close document | pending/running 取消 | no post-close mutation | queue.clear 不取消 running |
| scheduler retry 与新请求 | max=1 | A retry, B queued | schedule A/B | B 不早于 A final | maxRunning <= 1 | retry 释放并发槽 |
| scheduler cancel retry sleep | 1 request | retry sleep | cancelByDoc | 立即 reject | no second attempt | sleep 不可 abort |
| persistence timer overlap | many controllers | dirty events | flush tick overlaps close | 不重复写坏文件 | save order/allSettled | timer 和 close flush 并发 |

## 14. 性能与资源测试建议

| 风险点 | 代码位置 | 触发数据规模 | 影响 | 测试方法 | 优化建议 |
|---|---|---|---|---|---|
| runtime pruning disabled | `src/extension.ts:106-110` | >1000 nodes/doc | 内存无界增长 | 100k edits stress | 接入 archive prune executor |
| 内容重建深链 | `src/model/ctrlZTree.ts:46-60` | 10000 nodes deep path | undo/preview 卡顿 | benchmark getContent p95 | runtime 使用 ContentStore snapshot/LRU |
| findLatestNonEmpty O(n*depth) | `src/model/ctrlZTree.ts:169-188` | 大量节点且当前为空 | Ctrl+Z 卡顿 | synthetic empty head | 维护非空索引或 projection stats |
| `Math.max(...largeArray)` | `src/extension.ts:124-125` | 大闭包历史 | RangeError | 100k node cleanup | 循环求 max |
| TreeView getChildren 重建内容 | `src/ui/historyTreeProvider.ts:79-105` | 多 child/大内容 | UI 卡顿 | VS Code performance smoke | projection summary/cache |
| Webview full update | `src/webview/webviewManager.ts:407-412` | 300+ nodes | postMessage payload 大 | graph benchmark | patch protocol |
| Persistence gzipSync/encrypt foreground | `src/security/persistenceStore.ts:57-66` | 大 events/snapshots | event loop 阻塞 | flush benchmark | 后台队列、chunk/gzip async |
| Scheduler rate limit sleep up to 1h | `src/concurrency/requestScheduler.ts:176-188` | maxRequestsPerHour exhausted | 请求长时间无 UI 状态 | fake timer + stats | 暴露 queuedUntil/cancel UI |

## 15. 自动化测试建议

| 类别 | 建议 |
|---|---|
| 单元测试框架 | 继续使用 Mocha + assert；纯逻辑迁到 `src/test/suite/*.unit.test.ts` 或未来 `tests/unit` |
| 集成测试 | 使用 `@vscode/test-cli`，新增真实文件编辑、命令执行、TreeView、Diff editor、SecretStorage mock 场景 |
| Mock 框架 | 当前不引入重框架也可，使用手写 fake deps；若复杂度升高，可考虑 `sinon` 做 fake timers/stubs |
| 覆盖率工具 | `c8` 或 `nyc` 对纯逻辑测试收集覆盖；VS Code integration 单独报告 smoke 结果 |
| 静态扫描 | `npm audit --omit=dev`、`npm audit`、eslint no-floating-promises/no-console/no-explicit-any 分阶段开启 |
| CI 阶段 | compile -> lint -> unit -> integration -> security -> perf smoke -> package smoke |
| 测试命名 | 按 AGENTS：`*.unit.test.ts`、`*.integration.test.ts`、`*.contract.test.ts`、`*.security.test.ts`、`*.perf.test.ts` |
| 目录结构 | 保持当前 suite 可运行，同时逐步拆 `src/test/fixtures/<area>` 和 `tests/perf` |
| 覆盖率门禁 | `history/concurrency/config` 行覆盖 90%、分支 85%；`ai/redactor` 行 95%、分支 90%；整体先设 70%，逐步提到 V4 目标 |
| 测试输出 | 修复 `npm test` 输出，CI 必须显示 test count、failed count、耗时和 extension host exit code |

## 16. 建议新增测试文件

| 文件 | 覆盖内容 | 优先级 |
|---|---|---|
| `src/test/suite/extensionCommands.integration.test.ts` | undo/redo/checkout apply false/reject/success | P1 |
| `src/test/suite/persistenceService.integration.test.ts` | save/load/restart/corrupt/archive/no plaintext | P0 |
| `src/test/suite/persistenceConsent.security.test.ts` | 默认 ask/off 不落盘、SecretStorage 不可用 | P0 |
| `src/test/suite/requestSchedulerRetry.unit.test.ts` | returned error retry、retry cancel、concurrency during retry | P1 |
| `src/test/suite/documentTaskQueueCancellation.unit.test.ts` | async nested enqueue、close cancellation、running task token | P1 |
| `src/test/suite/webviewGraphProtocol.integration.test.ts` | shortHash collision、malformed payload、diff URI | P1 |
| `src/test/suite/historyOperations.integration.test.ts` | merge/delete/prune executor + projection invariant | P1 |
| `src/test/suite/configSchemaDrift.unit.test.ts` | package.json schema vs ConfigService coverage | P1 |
| `src/test/suite/aiFailClosed.security.test.ts` | invalid provider output、stale baseSeq、destructive plan confirmation | P1 |
| `tests/perf/history.perf.test.ts` | V4 p50/p95 thresholds | P2 |

## 17. 需要补充的信息

| 信息 | 为什么需要 | 影响范围 |
|---|---|---|
| 当前是否目标为“V4 全部完成上线”还是“阶段性开发版” | 当前代码与 TODO 状态冲突，git log 显示 W10，TODO 文档仍写未开始 | 验收标准严格程度 |
| 是否已有 CI 配置未提交 | 仓库未看到 GitHub Actions/workflow | 自动化门禁建议 |
| 真实发布版本规划 | README 写 0.6.0，package/CHANGELOG 是 0.5.7 | 发布验收 |
| 用户对默认持久化的产品期望 | V4 明确 ask，但当前自动保存 | 隐私合规 |
| Webview 是否允许源码摘要进 payload | V4 倾向最小 payload，但当前 UI 依赖片段预览 | 安全与体验取舍 |
| VS Code 最低版本是否仍为 1.60 | AI fetch/SecretStorage/test-cli 依赖较新运行环境 | 兼容矩阵 |

## 18. 加深复核补充

### 18.1 全仓库复核覆盖声明

本轮加深复核不再只看核心路径，而是先用 `rg --files --hidden --glob '!node_modules/**' --glob '!out/**' --glob '!.git/**' --glob '!.vscode-test/**' --sort path` 建立文件清单，再按类别读码。当前纳入复核的仓库文件为 86 个，约 19556 行。`node_modules`、`out`、`.git`、`.vscode-test` 作为依赖/构建/运行输出未按源码逐行复核。

| 类别 | 已复核文件/范围 | 复核结论 |
|---|---|---|
| 构建与配置 | `package.json`、`tsconfig.json`、`.eslintrc.json`、`.vscode-test.mjs`、`.vscodeignore`、`.gitignore`、`.vscode/**` | test-cli 可运行，但 lint 关键规则是 warn，`tsconfig` 若干严格项未启用，V4 配置 schema 缺口仍大 |
| 脚本与 fixture | `scripts/clean-vscode-test-env.mjs`、`test-fixtures/workspace/**` | 测试环境已隔离，但清理脚本缺少路径 guard；fixture 默认禁用 AI，无法覆盖 AI runtime 命令 |
| 核心源码 | `src/extension.ts`、`src/model/**`、`src/history/**`、`src/services/**`、`src/concurrency/**`、`src/config/**`、`src/security/**`、`src/ai/**`、`src/ui/**`、`src/utils/**` | 证实运行时仍是 legacy tree 主状态，V4 新模块多为旁路/影子状态 |
| Webview 与资源 | `src/webview/**`、`resources/vis-network.min.js` | `graphProtocol.ts` 未接入真实前端，Webview 仍走 legacy `updateTree` full payload；CSP 仍含 `unsafe-inline` |
| 测试 | `src/test/suite/**` 27 个测试文件 | 单元测试数量不少，但存在 sample/smoke/无断言/未 await 的假覆盖，关键 VS Code 命令与恢复路径未覆盖 |
| 文档 | `README.md`、`CHANGELOG.md`、`UPGRADE_DESIGN_PLAN-V4-CodeX.md`、`IMPLEMENTATION_TODOS.md`、`AGENTS.md` | V4 计划和 TODO 仍声明多个阶段未完成，README/package/CHANGELOG 发布状态不一致 |

### 18.2 新增或修正的高风险发现

| 编号 | 问题 | 位置 | 触发场景 | 影响 | 修复建议 | 验收标准 | 严重程度 |
|---|---|---|---|---|---|---|---|
| R-023 | Webview Reset 只替换 `historyTrees`，没有清理 `historyControllers` | `src/webview/webviewManager.ts:800-827`、`src/extension.ts:143-147` | 用户点击 Webview Reset 后继续编辑同一文档 | `getOrCreateController()` 会返回旧 controller，旧 controller 持有旧 tree；后续 commit、projection、persist 与新 UI tree 分裂 | reset 时关闭并删除对应 controller、清 pending/timer/persistence state，或统一通过 `HistoryController.reset()` 原子重建 | 集成测试：reset 后编辑，`historyTrees`、controller tree、projection head、持久化 events 全部来自新根；旧 events 不再落盘 | P1 |
| R-024 | `changeTracker` 不 await `controller.commit()`，却立即刷新 TreeView/Webview | `src/services/changeTracker.ts:126-151` | 前一个 commit 还在队列中，后一个编辑或 UI refresh 先发生 | UI 可能展示旧 tree，pending/processing 状态提前释放；异常只异步 log，不参与状态决策 | `processDocumentChange` 改为 async 并 await commit；commit 完成后再触发 `onDocumentCommitted` 和 Webview update | 用 fake slow queue 测试：commit 完成前 UI 不刷新；失败时不更新 TreeView/Webview，错误可观测 | P1 |
| R-025 | `graphProtocol.ts` 定义了 V2 `graphInit/graphPatch`，但 runtime 仍只发送/接收 legacy `updateTree` | `src/webview/graphProtocol.ts:1-86`、`src/webview/webviewManager.ts:397-412`、`src/webview/webview.js:306-329` | 大历史图更新或 V7 patch 协议验收 | “W7 graph protocol 完成”是死代码级别，性能/兼容验收没有落地 | 让 `webviewManager` 首次发送 `graphInit`，后续发送 `graphPatch`；前端实现并测试这两类消息；保留 legacy 兼容需有版本协商 | Webview integration 测试能观察 `graphInit`/`graphPatch` 被消费；300/1000 节点不再 full reload | P1 |
| R-026 | Webview 前端对 extension -> webview payload 无 schema guard | `src/webview/webview.js:303-329` | 后端 bug 发送缺字段/错类型 `updateTree` | `nodes.add(message.nodes)`、`edges.add(message.edges)` 可抛错并导致图谱空白或进入 `webviewError` | 前端增加 `isUpdateTreeMessage`/`isGraphInitMessage` 校验，错误显示安全占位并请求 reload | 单测/DOM 测试：空 payload、错类型、超大 payload 不崩溃，不执行导航 | P2 |
| R-027 | 点击节点会立即 navigate，与 select/diff 按钮绑定同一次点击冲突 | `src/webview/webview.js:253-263`、`src/webview/webview.js:299-302` | 用户只想选中节点看 diff 按钮 | 一次点击既选中又 checkout，可能覆盖当前文档状态，属于危险 UX | 改为双击/显式按钮/上下文菜单才 navigate；单击只 select | Webview 行为测试：单击不触发 `navigateToNode`，双击或按钮才触发 | P2 |
| R-028 | 测试套件存在假覆盖：sample、空测试、未 await 异步断言 | `src/test/suite/extension.test.ts:9-12`、`src/test/suite/editorApply.unit.test.ts:9-19`、`src/test/suite/historyController.unit.test.ts:161-173`、`src/test/suite/mergeDeleteEngine.unit.test.ts:49-53`、`src/test/suite/pruningEngine.unit.test.ts:92-101`、`src/test/suite/pruningEngine.unit.test.ts:130-139` | CI 显示绿灯 | 关键断言可能从未执行，误判 W2/W4/W5/W6 通过 | 删除 sample/空测试；所有 async 测试必须 `await`/`return`；开启 no-floating-promises 或用测试 wrapper 捕获 | 引入故意失败断言时测试会失败；每个测试至少有有效断言；CI 输出 test count | P1 |
| R-029 | `RequestScheduler` 的 `isRetryable` 字段未使用，provider 返回错误对象不会触发 retry | `src/concurrency/requestScheduler.ts:14-19`、`src/concurrency/requestScheduler.ts:81-93`、`src/ai/providers/base.ts:45-60`、`src/ai/aiService.ts:126-134` | Provider HTTP 429/5xx 解析为 `{ok:false,retryable:true}` | scheduler 把这次调用计为成功返回，`AiService` 才抛错，已经错过 retry 层 | scheduler 支持结果型错误或让 provider 对 retryable 错误 throw；使用 `req.isRetryable` 判定 | 单测：mock provider 连续返回两次 429 error object 后第三次成功，实际 attempts=3 | P1 |
| R-030 | retry sleep 期间释放并发槽，`maxConcurrentRequests=1` 时 queued 请求可与 retry 同时运行 | `src/concurrency/requestScheduler.ts:95-125`、`src/concurrency/requestScheduler.ts:133-137` | 请求 A 失败进入 retry sleep，请求 B 排队 | A 的 retry 与 B 可重叠，破坏限流和 provider 配额假设 | retry 应占用原请求生命周期，或将 retry 作为同一 queue item 不在 finally drain；sleep 需 abort-aware | fake timer 并发测试：A 完成全部 retry 前 B 不启动，`maxRunning` 始终 <=1 | P1 |
| R-031 | 配置和静态门禁弱，无法防止未来回归 | `.eslintrc.json`、`tsconfig.json`、`package.json:132-176` | 新增 floating promise、错配置、未覆盖 V4 key | lint/compile 绿灯但运行时行为错 | 逐步把关键 eslint 规则升为 error；启用 `noImplicitReturns/noUnusedParameters` 或等价 lint；增加 schema drift 测试 | CI 对未处理 Promise、V4 配置缺项、无效 HTTP baseUrl 失败 | P2 |
| R-032 | 持久化 load 路径跳过 malformed event line，且 runtime 从未调用 load | `src/security/persistenceService.ts:101-114`、`src/extension.ts:52-59`、`src/history/historyController.ts:277-292` | 落盘文件部分损坏或用户重启 VS Code | 用户以为历史恢复，实际坏事件静默丢失；当前重启完全不恢复 | manifest/event schema 严格校验，坏文件 archive 并告警；activation 时按 consent/config 加载恢复 | 集成测试：保存后重启恢复内容；损坏 event 导致 archive+告警，不是静默部分加载 | P0 |
| R-033 | 资源/打包可验证性不足 | `.vscodeignore`、`resources/vis-network.min.js` | 打包 VSIX 后运行 Webview | Webview runtime 依赖 `src/webview/**` 被特意 unignore，易被 ignore 顺序破坏；vendor sourcemap 注释指向缺失 map，缺 benchmark/source hash | 增加 `vsce package --no-dependencies` 或 `npx @vscode/vsce ls` 包内容 smoke；记录 vendor 来源/hash；移除或打包 map | package smoke 验证 VSIX 内含 `src/webview/html/css/js` 和 `resources/vis-network.min.js`，Webview 打开成功 | P2 |

### 18.3 测试覆盖重新评价

首版报告说“测试不足”仍成立，但加深复核后要更严格：当前测试不只是缺少场景，还存在测试本身会给出误导性绿灯的问题。

| 测试文件 | 当前问题 | 必须补强 |
|---|---|---|
| `src/test/suite/extension.test.ts` | 仍是 VS Code quickstart sample，与扩展功能无关 | 替换为真实激活、命令注册、打开 fixture 文件、执行 undo/redo/visualize 的 integration smoke |
| `src/test/suite/editorApply.unit.test.ts` | “unknown scheme” 用例没有调用函数，只 `assert.ok(true)` | 在 extension host 里创建真实 document，mock/触发 apply false、verify mismatch、成功路径 |
| `src/test/suite/historyController.unit.test.ts` | `recordHeadMove` 用例里 `controller.commit(...).then(...)` 没有 await/return | 改成 `async` + `await`，并断言 projection/event seq |
| `src/test/suite/mergeDeleteEngine.unit.test.ts` | `soft delete on non-head leaf node is valid` 无断言 | 补完整断言或删除该用例 |
| `src/test/suite/pruningEngine.unit.test.ts` | 至少两个用例只有注释没有断言 | 补 archive/delete/keep 的精确断言 |
| `src/test/suite/persistenceService.unit.test.ts` | 只测 fingerprint，不测 save/load/delete/corrupt | 增加 workspace.fs fake 或 extension host 集成测试 |
| `src/test/suite/requestScheduler.unit.test.ts` | 测 throw 型错误 retry，没测 provider error-object retry、retry sleep 并发、cancel during retry | 增加 fake timer 和 maxConcurrent=1 的高风险路径 |
| `src/test/suite/webviewMessageSchema.unit.test.ts` | 只测 webview -> extension incoming guard | 增加 extension -> webview outgoing graph/update payload guard |

### 18.4 对首版结论的修正

| 首版表述 | 加深复核后的修正 |
|---|---|
| “Webview graph protocol 未完成” | 更精确地说：`graphProtocol.ts` 是未接入的旁路代码，真实前端只认识 `updateTree`，因此 W7 不能按协议验收 |
| “测试缺真实命令覆盖” | 更严重：已有若干测试是 sample/无断言/未 await，CI 绿灯会掩盖失败 |
| “持久化不可恢复” | 进一步确认：除了 runtime 不调用 load，保存内容本身也缺 `ContentStore` 正文，且 malformed event 被静默跳过 |
| “TreeView/Webview 使用 shortHash 风险” | 进一步确认：Webview 碰撞时直接跳过节点，TreeView `TreeItem.id` 仍是 `docUri:nodeHash`，均未采用 V4 `DocId:NodeId` |
| “队列取消不足” | 进一步确认：reset 状态流还会导致旧 controller 继续参与后续 commit/persist，属于状态分裂风险 |

## 19. 最终验收结论

基于当前代码，结论为：高风险，建议暂停按 V4 完整能力上线。

可以继续做内部开发版测试，但必须先修复 P0/P1：

1. 持久化默认授权、加载恢复、ContentStore payload 持久化。
2. Reset/close/deactivate 的 controller、tree、persistence 状态一致性。
3. W4 merge/delete/prune 执行器和 runtime pruning。
4. Scheduler retry/cancel/concurrency 语义。
5. DocumentTaskQueue cancellation、changeTracker await commit，以及命令写路径队列化。
6. TreeView/Webview 从 hash/shortHash 迁移到 `DocId:NodeId`，并接入真实 graph protocol。
7. AI response fail-closed 校验接入 `AiService`。
8. 真实 VS Code 命令集成测试替换 sample/smoke/无断言假测试。

在这些修复完成前，当前测试通过只能说明已有单元守卫没有失败，不能证明 V4 的核心可靠性、安全性和功能验收达标。
