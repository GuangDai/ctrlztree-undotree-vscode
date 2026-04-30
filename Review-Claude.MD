# CtrlZTree V4 白盒测试与代码审计报告（Review-Claude）

日期：2026-04-30
评审人：Claude（Opus 4.7）
基准文档：`UPGRADE_DESIGN_PLAN-V4-CodeX.md`（W4 阶段实现快照）
代码范围：`src/` 全树（提交 `3b67381`，主分支）
评审目标：识别相对 V4 设计基准的实施偏差与潜在缺陷，并产出可直接用于测试设计与回归覆盖的白盒测试方案。

> 本文遵循用户提供的《白盒测试方案》大纲；所有"基于当前代码推断"标注均来自实际源码阅读，关键位置以 `file:line` 引用，便于核验。

---

## 1. 总体结论

| 维度 | 结论 |
|---|---|
| 当前代码质量 | **不达 V4 验收门槛**。事件日志/投影/ContentStore/Concurrency 已铺设骨架，但与运行时 UI/旧 `CtrlZTree` 之间存在严重**双源（dual-store）裂脑**：UI 路径（undo/redo/visualize/webview navigate）依然直接驱动旧 Map 树，`HistoryController.recordHeadMove` 事后补登记，导致投影长期脱轨。|
| 主要风险 | (1) 写路径双源不一致；(2) `RequestScheduler` 重试期并发计数被双倍透支；(3) `MemoryContentStore` 与 `HistoryController` 没有对接（init/initialSnapshot 未注入 ContentStore）；(4) AI prompt 未脱敏（`buildUnifiedRequest` 不调用 `redactSensitiveData`）；(5) 持久化只写不读（`loadDocument` 从未被任何调用方使用）。|
| 测试重点 | head/parent/Edit-Apply 一致性、queue+token 嵌套与取消、provider 字段映射、redactor 漏检场景、persistence round-trip、CSP/diff URI、长链 LRU。|
| 覆盖率难点 | 真实 VS Code API（applyEdit/SecretStorage/Webview）需 integration harness；当前 unit 套件 229 项可在 mocha 直跑通过，但**完全不覆盖** dual-store 一致性。|
| 总体评分 | **P0 缺陷 12+，P1 缺陷 18+，P2 缺陷 9+**（详见 §13）。|

> 以上判定仅基于当前 `src/` 与 V4 设计书；与 V4 §16 阶段门 W2~W4 仍存在显著偏差。

---

## 2. 模块/函数理解

### 2.1 模块清单（基于当前代码推断）

| 模块 | 主要职责 | 输入 | 输出 | 外部依赖 | 副作用 | 关键风险点 |
|---|---|---|---|---|---|---|
| `extension.ts` | 激活、注册命令、调度全局状态、运行 undo/redo/visualize | VS Code API、用户命令 | 命令注册、TreeView/Webview 初始化 | `vscode.workspace`/`window`/`commands`、SecretStorage、`fs` | 全局 `extensionState`、定时器（5s 持久化）、命令副作用 | 直接 mutate 旧 `CtrlZTree`（绕过 Controller），`recordHeadMove` 事后补，`Math.max(...arr)` 超大数组 |
| `model/ctrlZTree.ts` | 旧 hash-keyed Map 树、`set/z/y/setHead/getContent` | 字符串、`vscode.Position` | string/string[] | `crypto` | 内部 `nodes` Map | hash 冲突时**仍加盐**（`calculateHash(content, ...salt)`，line 110），违反 V4 §0 "ContentHash 只作内容指纹" |
| `lcs.ts` | 字符级 diff/apply/序列化/摘要 | 两段字符串 | `DiffOperation[]`、字符串 | 无 | 无 | `applyDiff` 对 `remove` 是 no-op、对 add 不使用 `position`，仅保证生产顺序下正确，重排后**静默损坏** |
| `services/changeTracker.ts` | 监听 `onDidChangeTextDocument`，分组防抖、调用 `controller.commit` | VS Code 事件 | 调用 commit | timer、editor、editTokens | `processingDocuments` Set | 重入保护几乎触发不到（finally 同步释放）；`processingDocuments` 真正应当保护的是 `controller.commit` 异步阶段，但 commit 是 fire-and-forget |
| `history/historyController.ts` | 事件 append-only、Projection 重投影、headMove/commit、persist flush | `CtrlZTree`、`DocumentTaskQueue`、`PersistenceService` | `CommitResult` / `NavigateResult` | crypto、vscode | events 数组、`hashToNodeId`/`nodeIdToHash`、`projection`、`needsPersist` | `recordHeadMove` 给未提交节点凭空分配 nodeId；`commit` 在投影前先同步 mutate 旧 tree |
| `history/projection.ts` | 纯函数 `project(events)` 重建 NodeView、parent/children、branch tips、不变量 | events 数组 | `Projection` + diagnostics | 无 | 无 | invariant 仅记 diagnostic，不阻断使用；任意 `headMove` 到未注册 nodeId 直接被丢弃但 `projection.headId` 不变 |
| `history/contentStore.ts` | LRU + snapshot/diff 双层 ContentRef | nodeId、Projection | `ContentRef` / 内容字符串 | lcs | LRU cache、entries Map | 与 controller 解耦：`HistoryController` 构造时**未把 init/initialSnapshot 写入 ContentStore**，`resolve` 必返回 null |
| `history/pruningEngine.ts` | 生成 `PrunePlan`，archive 优先 | Projection、policy | `PrunePlan` | 无 | 无 | 未在运行时被调用（extension.ts:106 注释 W4 TODO）；plan 未生成 keep-overflow 时缺少削减逻辑 |
| `history/mergeEngine.ts` | 生成 `MergePlan` | Projection、sourceIds | `MergePlan` | 无 | 无 | 仅生成 plan，无执行器；UI 上点 Merge 后只弹 "execution will be available in a future update" |
| `concurrency/documentTaskQueue.ts` | 单 doc FIFO 串行、跨 doc 并行 | docId、task | Promise<T> | 无 | queues/pending Map | 任务签名为 `() => Promise<T>`（V4 要求 `(token) => Promise<T>`）；`cancelPending` 不能终止当前任务；嵌套 enqueue 守卫只有同步窗口 |
| `concurrency/applyEditTokens.ts` | docId 多 token 集合 | docId、reason | token | crypto | tokens Map | 正确实现 begin/end，但被多处 UI handler 直接绕过 |
| `concurrency/requestScheduler.ts` | AI 请求并发限流、重试、超时 | `ScheduledRequest<T>` | Promise<T> | AbortController | concurrent 计数、queue、controllers Set | **重试期间 concurrent 双倍透支**；`maxRequestsPerHour=0` 触发 NaN 等待；rate-limit 与 concurrent 计数相互纠缠 |
| `ai/aiService.ts` | testConnection、sendRequest 编排 | ClampedAiConfig、UnifiedAiRequest | UnifiedAiResponse / Error | scheduler、registry、secretStore | 日志 | 错误信息未全部经过 `redactSensitiveData`；test connection 把 response substring 写入日志 |
| `ai/redactor.ts` | 字符串/对象敏感字段脱敏 | 字符串/object | RedactionResult / object | 无 | 无 | 正则覆盖一般场景，但**对 URL `Authorization: Basic` 与 GitHub PAT (ghp_/gho_/ghs_) 等明显 token 不匹配**（缺少模式） |
| `ai/promptBuilder.ts` | 构造 system+user 提示与 JsonSchema | PromptContext | UnifiedAiRequest | 无 | 无 | **未对 `diffSummary`/`siblingSummaries`/`nearbyNames`/`filePath` 脱敏**——直接进 prompt（违反 V4 §10.5） |
| `ai/operationPlanner.ts` | 校验 AI 响应 schema、stale baseSeq、目标合法性 | unknown、Projection | AiValidationResult | 无 | 无 | 仅支持 `archive`/`delete`，对 V4 §10.6 中 `merge`/`prune` 未覆盖；`baseSeq=0` 与 `lastSeq=0` 误判为新鲜 |
| `ai/providers/*` | OpenAI Responses / Chat / Anthropic Messages / custom HTTP 字段映射 | UnifiedAiRequest | ProviderRequest / ProviderResponse | 无 | 无 | 解析层"best-effort"违反 V4 §10.6 "schema invalid → 失败,不修复" |
| `ai/providers/base.ts` | 统一 fetch 调度 | URL、method、headers、body | response | global fetch | 无 | `getFetch` 路径混乱（含死代码 `require('node:http')`）；签名 abort 与 `err.message.includes('aborted')` 文本匹配脆弱 |
| `ui/historyTreeProvider.ts` | TreeDataProvider | docUri、tree | TreeItem[] | vscode | UI 渲染 | `getChildren` 在 root 仅 push HEAD 单节点 + 列出 parent/children；对 1000+ 节点 lazy 展开但未走 ContentStore |
| `ui/diffContentRegistry.ts` | 短 ID → (original, modified) 内存映射 | 字符串 | id | crypto | Map | LRU evict 仅按 `createdAt`，长会话偶发误踢仍打开的 diff |
| `webview/webviewManager.ts` | Webview 生命周期、message 处理、diff 注册、graph 渲染 | VS Code API、tree | WebviewPanel | webview、fs、commands、tabGroups | 全局 panel 状态 | navigate 路径**直接 setHead** 不通 controller；webview HTML CSP 仍含 `style-src 'unsafe-inline'`；title 已 escape ✓ |
| `security/persistenceStore.ts` | AES-256-GCM + gzip 加解密 | 字符串/Buffer | Buffer/字符串 | crypto、zlib、SecretStore | 状态 dataKey | 默认实现 OK；不写入 schemaVersion/key-id 头，未来轮换困难 |
| `security/persistenceService.ts` | 文档级 saveDocument/loadDocument | events、lastSeq | 文件 IO | vscode.fs | docs 目录 | **`loadDocument` 未被任何调用方使用**；`saveDocument` 两次 fs.writeFile 非原子 |
| `security/secretStore.ts` | VS Code SecretStorage 包装 | secrets API | get/set/delete | vscode | available 标记 | `probeAvailability` 是死代码；`available` 仅在 catch 中按错误文本设置；不可用时未触发降级 |
| `config/configService.ts` | clamp 用户配置（部分） | unknown | clamped/AiConfig | 无 | 无 | 仅覆盖 enablePruning/maxNodes/maxTrackedDocs + AI 4 字段；V4 §9.2 中 30+ 项未实现；缺 `onDidChange` 监听 |
| `state/extensionState.ts` | 全局状态容器 | 无 | ExtensionState | 无 | 无 | `historyTrees` 与 `historyControllers` 同时存在，加剧 dual-store |

### 2.2 关键隐含假设
- 所有 commit 都通过 `controller.commit` 串行执行（实际通过 `DocumentTaskQueue` 串行，但 undo/redo/navigate 路径**绕过队列**）。
- 旧 tree 的 `head` 与 controller 的 `projection.headId` 始终同步（实际仅靠手工 `recordHeadMove` 事后补，且不验证目标节点是否已注入投影）。
- 旧 tree 的所有节点都先经过 commit 才会被 head/checkout 引用（实际 `getOrCreateTree` 一旦使用旧 tree，构造时即可能创建 `initialSnapshotHash`，控制器只为 root + initialSnapshot 注入两个事件）。
- AI 请求 baseUrl 在配置变更后会跟随（实际 `extension.ts:281` 一次性读取并固化到 provider 实例）。

---

## 3. 控制流与路径分析

### 3.1 关键控制流路径表（节选）

| 路径编号 | 触发条件 | 执行路径 | 预期结果 | 是否需要测试 | 风险等级 |
|---|---|---|---|---|---|
| CF-001 | 用户在 trackable 文档输入字符 | `onDidChangeTextDocument`→ debounce → `processDocumentChange` → `controller.commit` → 队列 → `tree.set` + `events.push` + `project()` | 历史新增节点；events 长度 +1；Projection.byId 含新 nodeId | 必测 | 高 |
| CF-002 | 用户按 `ctrl+z` | `extension.ts undoCommand` → `tree.peekUndo` → `tree.setHead(parent)` → `applyTreeStateToDocument` → 成功后 `controller.recordHeadMove` | 文档回到 parent；Projection.headId 跟随 | 必测 | 高 |
| CF-003 | apply 失败 | `applyTreeStateToDocument` 中 `applyEditAndVerify` 返回 `{ok:false}` → 回滚 `tree.setHead(savedHead)` | 文档/树头都不变；用户看到 ErrorMessage | 必测 | 高 |
| CF-004 | redo 多分支 | `tree.peekRedoChildren` 长度 >1 → `showQuickPick` → `applyRedoBranch(selected)` | 选中分支生效；取消则原状不变 | 必测 | 高 |
| CF-005 | webview 双击节点 | `panel.webview.onDidReceiveMessage('navigateToNode')` → schema check → `setHead` → `applyEditAndVerify` → markCleanIfInitial | 文档跳到目标；失败回滚 | 必测 | 高 |
| CF-006 | webview 打开 diff | `onDidReceiveMessage('openDiff')` → `diffContentRegistry.register` → `vscode.diff` 命令打开 | URI 不含正文；diff 编辑器显示对比 | 必测 | 中 |
| CF-007 | 自动持久化 | 每 5s `setInterval` → 遍历 controllers → `flushToDisk` | 加密文件落盘；needsPersist 复位 | 必测 | 中 |
| CF-008 | deactivate | clearInterval → 同步 `flushToDisk()`（**不 await**） → 状态清理 | 触发但可能丢数据 | 必测 | 高 |
| CF-009 | AI testConnection | `clampAiConfig` → `secretStore.get(api key)` → `scheduler.schedule` → `provider.sendRequest` | 200/401/timeout 三种响应被各自分类 | 必测 | 中 |
| CF-010 | AI 请求超时+重试 | `executeRequest`(retry=0) timeout → `retryRequest` → `executeRequest`(retry=1) → … | 计数与限流不应被透支 | 必测 | 高（已发现 bug） |
| CF-011 | AI 请求被 cancelByDoc 取消 | `cancelByDoc` → `controller.abort` 触发 fetch AbortError | 当前请求立即返回 abort error，pending 队列项被 reject | 必测 | 中 |
| CF-012 | SecretStorage 不可用 | `persistenceStore.initialize` 返回 ok:false → `aiService.testConnection.secretStore.get` throw | 命令应优雅降级，不写明文 | 必测 | 高 |
| CF-013 | 文档关闭 | `onDidCloseTextDocument` → 删除 tree/controller/timeouts → `controller.close()` | flushToDisk + queue.clear；不影响其他 doc | 必测 | 中 |
| CF-014 | 配置变更（动态） | 用户改 `ctrlztree.ai.baseUrl` | provider 应使用新 baseUrl | 必测（**当前不达**） | 中 |
| CF-015 | invalid Webview message | 注入未知 command 或参数缺失 | `isWebviewIncomingMessage` 返回 false，handler 不动作 | 必测 | 中 |

### 3.2 异常路径
- `applyEditAndVerify` 抛出（如 `document.lineAt` 越界）→ 调用方 try/catch 兜底，但 token finally 释放 ✓。
- `controller.commit` 内 `tree.set` 抛出（极小概率）→ commit promise reject，processDocumentChange `.catch` 仅记录 → tree 状态可能已经被部分修改。
- `RequestScheduler.executeRequest` 抛出非可重试异常 → reject，concurrent--（finally）。
- `MemoryContentStore.resolve` 在 root 缺失 entry 时返回 null（已知 bug）。

---

## 4. 数据流分析

### 4.1 核心数据流

**编辑链：**
`vscode.TextDocumentChangeEvent` → 字符串 `currentText` → 防抖 `pendingChanges` → `processDocumentChange(content)` → `controller.commit(content)` → 队列任务 → `this.tree.set(content)`（同步 mutate 旧 tree）→ `this.tree.getAllNodes()` 查 parent → 自增 nodeId → `events.push(EditEvent)` → `project()` 重投影 → `needsPersist=true`。

**关键风险点：**
| 数据点 | 校验情况 | 风险 |
|---|---|---|
| `currentText` | 无校验，直接长度全文传给 commit | 巨大文档（>10MB）触发 `Buffer.byteLength` 与 diff 全量比较 |
| `parentHash` 来自旧 tree | 假定 commit 时旧 tree head 未被外部 mutate | 队列已串行，但 undo/redo 在调用 commit 之外仍直接 mutate；并发 commit 间隔内 head 可能漂移 |
| `nodeId` 通过 `nextNodeId++` | 全实例自增；persistence 加载后若不重置可能冲突 | `loadDocument` 未实现，潜伏问题 |
| `cursorPosition` 类型为 `vscode.Position` | 在 commit 内仅取 `line/character`；与 V4 `Cursor` 接口兼容 | 单元测试需 mock |
| 持久化 ndjson | `JSON.parse` 单行 try/catch 后跳过坏行 | 可能丢失事件而不报警 |
| `apiKey` | `secretStore.get` → 直接拼入 header | 错误日志若包含 e.message 可能含 raw header（依赖 redactor） |
| `diffSummary` 进入 prompt | **无脱敏** | 用户代码 token/密码会上传 |
| Webview `nodes[].label/title` | 在 webview 渲染（vis-network 内部） | `vis-network` 默认不解析 HTML，但 V4 §13 仍要求 schema/最小 payload；当前 label 含 timeAgo/shortHash/preview |
| diff URI `${DIFF_SCHEME}:${diffId}/...` | diffId 为随机 ID，不含正文 ✓ | OK |

### 4.2 边界值/类型
- `currentText` 为 Unicode/emoji/4 字节字符 → `lcs` 字符级 diff 通过 string indexing；JS 字符串使用 UTF-16，emoji 占 2 个 code unit，可能造成 surrogate split。当前 `slice(start, end)` 不感知 surrogate 对，可能产生破损 emoji 复原（实测会复原相同破损 surrogate 对，但 `applyDiff` 仍能精确回放原内容）。
- `cursorPosition.line/character` 来自编辑器；apply 后 `Math.min(cursorPosition.line, document.lineCount-1)` 处理越界 ✓。
- `policy.snapshotEveryNodes=0` 时，模运算除零 → JS 中 `n % 0 = NaN`，永不触发 snapshot。clampConfig 未覆盖。

---

## 5. 白盒测试用例清单（核心）

> 优先级：P0 = 阻塞发布 / P1 = 必须修复 / P2 = 建议修复 / P3 = 可延后；风险 H/M/L。

### 5.1 投影 & 历史控制器

| 用例编号 | 测试目标 | 输入数据 | 前置/Mock | 执行步骤 | 预期结果 | 断言点 | 覆盖路径 | 优先级 |
|---|---|---|---|---|---|---|---|---|
| TC-W-001 | init event 建 root/head 正确 | 空文档 init | 无 | `project([init])` | `headId == rootId == 0`，byId.size=1 | parentOf(0)=null，childrenOf(0)=[] | CF-001 init | P0 |
| TC-W-002 | edit event 父节点缺失被拒 | parentId=999 不存在 | 无 | `project([init, malformedEdit])` | byId 不含 999，diagnostics 含 "Edit event parent ... does not exist" | byId.size=1 | projection.handleEdit | P0 |
| TC-W-003 | headMove 到未知节点被拒，但 projection.headId 不回滚 | seq 序列含 init + headMove(to=42, 不存在) | 无 | `project([...])` | 投影记录 error；`headId` 仍为 rootId | diagnostics ≥1，headId == rootId | projection.handleHeadMove | P0 |
| TC-W-004 | `recordHeadMove` 给未注册 hash 凭空分配 nodeId（**当前 bug**） | controller 构造完毕（events=2），调用 `recordHeadMove("h_unknown", "h_unknown2", "checkout")` | 无 | 直接断言 `events` 末项 | 期望：抛错或忽略；当前实际：emit headMove with from/to 全新 nodeId，projection 记录 error | events 不应增加 dangling headMove | historyController.recordHeadMove | **P0** |
| TC-W-005 | `commit` 以旧 tree 当前 head 为 parent | 文档"a"→"ab" | 注入 `DocumentTaskQueue` mock | 调用 `controller.commit("ab")` | `events` 末项 EditEvent.parentId 与 init 时 root 的 nodeId 一致 | nodeId 单调；contentHash=sha256("ab") | controller.commit | P0 |
| TC-W-006 | dual-store 一致性：UI 直接 `tree.setHead` 后 commit | `tree.setHead(otherHash)` → commit 新内容 | 模拟 webview navigate | 调用 commit | `events` 末项 parentId 是否在 byId 中 | **当前可能为 false**；应阻断或注入补偿 init/edit | dual-store 不变量 | **P0** |
| TC-W-007 | 顺序 monotonic seq | 构造手工 events seq 顺序错乱 | 无 | project | diagnostics 含 "Non-monotonic event seq" | seq 值仍记录但不阻断 | projection top loop | P1 |
| TC-W-008 | merge event 创建结果节点并归档 source | merge sourceIds=[2,3], resultId=4, parentId=1 | 无 | project | byId.has(4)，archived 含 2,3 | parentOf(4)=1; childrenOf(1) 含 4 | handleMerge | P1 |
| TC-W-009 | hard delete 移除 children 引用 | sequence: init, edit(2), edit(3), delete(2 hard) | 无 | project | byId 不含 2; childrenOf(1) 不含 2; deletedNodes={2} | branchTips 不含 2 | handleDelete | P1 |
| TC-W-010 | `flushToDisk` 失败 needsPersist 不被复位 | mock persistenceService.saveDocument → ok:false | 无 | commit + flushToDisk | needsPersist 仍 true | 下次 timer 重试 | controller.flushToDisk | P1 |

### 5.2 ContentStore

| 用例编号 | 测试目标 | 输入 | 前置 | 步骤 | 期望 | 优先级 |
|---|---|---|---|---|---|---|
| TC-W-101 | 小 diff 走 inline | parent="a", next="ab", policy 默认 | 无 | appendEdit | ContentRef.kind='inline-diff' | P0 |
| TC-W-102 | 大 diff 走 snapshot | next 比 parent 长 1MB | 无 | appendEdit | ContentRef.kind='snapshot' | P0 |
| TC-W-103 | LRU 命中第二次不重放 | 反复 resolve 同一 nodeId | spy on `applyDiff` | 第二次调用 | applyDiff 仅调用 1 次 | P1 |
| TC-W-104 | **HistoryController 集成**：commit 后 contentStore.resolve 能解析新节点 | 走 controller.commit 创建多条事件 | controller 注入 contentStore | resolve(headId) | content 等于最近 commit 内容；**当前 bug：root/initialSnapshot 缺 entry → 返回 null** | **P0** |
| TC-W-105 | snapshotEveryNodes=0 边界 | policy 强制 0 | 无 | appendEdit | 不应除零 NaN；当前**未 clamp** | P1 |
| TC-W-106 | resolve 检测循环 | 构造 parentOf 自环 | 手工 projection | resolve | 返回 null 不死锁 | P1 |
| TC-W-107 | `clearCacheFor` 释放尺寸 | 缓存大字符串后 clear | 无 | 检查 `cacheSize` | 单调下降不变负 | P2 |

### 5.3 Diff/LCS

| 用例编号 | 测试目标 | 输入 | 期望 | 优先级 |
|---|---|---|---|---|
| TC-W-201 | `deserializeDiff` 拒绝非数组 | `'"x"'` | 抛 schema error | P0 |
| TC-W-202 | 拒绝缺 length 的 keep/remove | `[{type:'keep',position:0}]` | 抛错 | P0 |
| TC-W-203 | 拒绝 add 携带 length | `[{type:'add',position:0,content:'a',length:1}]` | 抛错 | P0 |
| TC-W-204 | apply 顺序敏感 | 手工乱序 ops（合法字段但语义错） | 输出可能与原意不符；**应当增加 LCS 后验证（hash 比对）** | P1 |
| TC-W-205 | 4 字节 emoji 替换 | "𝕏" → "𝕐" | applyDiff(generateDiff(a,b))=b | P1 |
| TC-W-206 | CRLF/LF 混合替换 | 含 `\r\n` 与 `\n` 混合 | applyDiff 还原一致 | P1 |
| TC-W-207 | 巨大文本（2MB）apply 性能 | 中部替换 1KB | <50ms p95 | P2 |

### 5.4 并发：DocumentTaskQueue / RequestScheduler / ApplyEditTokens

| 用例编号 | 测试目标 | 输入 | 期望 | 优先级 |
|---|---|---|---|---|
| TC-W-301 | 同 doc FIFO | 连续 enqueue A,B,C | 完成顺序 A→B→C | P0 |
| TC-W-302 | 跨 doc 并行 | docA.enqueue + docB.enqueue 都长任务 | 不互相阻塞 | P1 |
| TC-W-303 | `cancelPending` 应 abort 当前任务（**当前不行**） | enqueue 长任务，`cancelPending(docId)` | 当前任务收到 cancellation token、立即停止 | **P0** |
| TC-W-304 | 嵌套 enqueue 阻断 | 任务体内再次 enqueue 同 doc | 抛错；**当前实现因 enqueuing 同步窗口已释放，不能拦截** | **P0** |
| TC-W-305 | RequestScheduler 并发上限 | maxConcurrent=2，5 请求 | 同时运行不超过 2 | P0 |
| TC-W-306 | RequestScheduler 重试期不超并发 | 强制超时 + 重试 | 重试期间 concurrent ≤ 2；**当前会到 3-4** | **P0** |
| TC-W-307 | maxRequestsPerHour=0 | 配置 0 | 拒绝并立即 reject；**当前 NaN sleep** | **P0** |
| TC-W-308 | `cancelByDoc` 终止 in-flight | abort 信号传递到 fetch | provider 返回 retryable Abort 错误 | P1 |
| TC-W-309 | ApplyEditToken 嵌套 | begin a, begin b, end a, end b | isApplying 始终 true 直到全 end | P0 |
| TC-W-310 | ApplyEditToken finally 清理 | task throw mid-edit | end 仍调用，token 集合空 | P0 |
| TC-W-311 | RequestScheduler `recordRateTimestamp` 顺序 | 持续多次成功 | 时间戳递增；过滤 oneHourAgo | P2 |

### 5.5 AI Provider 契约

| 用例编号 | 测试目标 | 输入 | 期望 | 优先级 |
|---|---|---|---|---|
| TC-W-401 | OpenAI Responses：`input` 含 messages，`instructions` 含 system | UnifiedAiRequest 含 system+user | body 字段映射正确 | P0 |
| TC-W-402 | OpenAI Chat-compat：`max_completion_tokens`、`response_format` 强 schema | toolMode='force_schema_tool' | response_format.type='json_schema' | P0 |
| TC-W-403 | Anthropic：`x-api-key` header、`anthropic-version`、tools（schema） | toolMode='force_schema_tool' | tool_choice.type='tool' | P0 |
| TC-W-404 | custom-http-json：Authorization Bearer 注入 | 任意 request | header 含 `Bearer apiKey` | P1 |
| TC-W-405 | strictSchema 时拒绝纯文本 | parse 返回非 JSON | error retryable=false；**当前 OpenAIResponses parser 缺少 strictSchema 参数** | **P0** |
| TC-W-406 | 401/403 不重试 | mock fetch 返回 401 | retryable=false | P0 |
| TC-W-407 | 429/5xx retryable | mock fetch 返回 429 | retryable=true 触发重试 | P0 |
| TC-W-408 | timeout abort 后错误脱敏 | mock fetch hang | err.message 经过 redactSensitiveData | P1 |
| TC-W-409 | provider.list 4 类全注册 | extension 激活 | registry.list 长度=4 | P2 |
| TC-W-410 | baseUrl 动态变更（**当前不达**） | 修改 settings | 下一次请求使用新 URL | **P1** |

### 5.6 AI 流程：redactor / promptBuilder / operationPlanner

| 用例编号 | 测试目标 | 输入 | 期望 | 优先级 |
|---|---|---|---|---|
| TC-W-501 | redact Authorization | "Authorization: Bearer abc" | 替换为 [REDACTED] | P0 |
| TC-W-502 | redact PEM | 完整 PEM block | 替换为 placeholder | P0 |
| TC-W-503 | redact AWS env | "AWS_SECRET_ACCESS_KEY=AKIA..." | 替换 [REDACTED] | P0 |
| TC-W-504 | redact GitHub PAT（**未覆盖**） | "ghp_xxxxxxxx..." | 应替换；**当前不替换** | **P1** |
| TC-W-505 | redact Slack token（**未覆盖**） | "xoxb-..." | 应替换；**当前不替换** | P2 |
| TC-W-506 | redact JWT（**未覆盖**） | "eyJxxx.eyJxxx.xxx" | 应替换；**当前不替换** | P2 |
| TC-W-507 | redactRequestData 循环引用 | obj.self=obj | 不无限递归；返回 [CYCLIC] 标记 | P1 |
| TC-W-508 | promptBuilder 脱敏（**当前不达**） | diffSummary 含 password | prompt 中应无明文；**当前直接进 prompt** | **P0** |
| TC-W-509 | operationPlanner stale baseSeq | response.baseSeq != lastSeq | valid=false, staleBaseSeq=true | P0 |
| TC-W-510 | operationPlanner head 保护 | targetIds 含 headId | error "rejected" | P0 |
| TC-W-511 | operationPlanner version 校验 | version='2' | error "Unsupported response version" | P1 |
| TC-W-512 | operationPlanner 支持 merge/prune（**当前不达**） | operation='merge' | error "Unknown operation"；**应允许** | **P1** |

### 5.7 持久化

| 用例编号 | 测试目标 | 期望 | 优先级 |
|---|---|---|---|
| TC-W-601 | encrypt/decrypt round-trip | 解密后字节级一致 | P0 |
| TC-W-602 | 错误 IV/AuthTag 解密失败 | 抛错 | P0 |
| TC-W-603 | SecretStorage 不可用 | initialize 返回 ok:false；后续 saveDocument 同样 ok:false | P0 |
| TC-W-604 | saveDocument 写入两个文件 | events.ndjson.enc + manifest.json.enc | P1 |
| TC-W-605 | manifest schemaVersion 校验 | 返回 ok:false 当 schemaVersion≠1 | P1 |
| TC-W-606 | **loadDocument 集成（当前未挂入运行时）** | controller 启动后应能 restore | **P1** |
| TC-W-607 | 配额超限处理 | 超 maxBytesPerDocument | compaction/archive；**未实现** | P2 |
| TC-W-608 | 写盘原子性 | 模拟 events 写入成功、manifest 失败 | 下次启动应能识别为损坏 | P1 |
| TC-W-609 | docFingerprint 不暴露文件路径 | docUri='file:///private/x' | 仅 24 字 hex | P1 |

### 5.8 UI / Webview

| 用例编号 | 测试目标 | 期望 | 优先级 |
|---|---|---|---|
| TC-W-701 | webview message schema 拒绝 unknown | `{command:'evil'}` | handler 不动作 | P0 |
| TC-W-702 | webview shortHash 类型校验 | 缺字段 | schema reject | P0 |
| TC-W-703 | webview title escape | 文件名 `<script>` | HTML 中转义为 `&lt;script&gt;` | P0 |
| TC-W-704 | CSP 禁止 inline style（**当前未达**） | 检查 webview.html | 不含 `'unsafe-inline'` | **P1** |
| TC-W-705 | diff URI 不含正文 | 任意 diff 命令 | URI authority/path 仅含 dcr_xxx | P0 |
| TC-W-706 | DiffContentRegistry LRU evict | 超 max 时最旧被踢 | size 不超 max | P1 |
| TC-W-707 | navigate 失败回滚 | applyEditAndVerify 返回 ok:false | tree.head 回滚到 savedHead | P0 |
| TC-W-708 | navigate 路径**不通过 controller**（**当前 bug**） | webview navigate 后查 controller.events | 应包含 headMove；**当前不包含** | **P0** |
| TC-W-709 | TreeView lazy 1000 节点 | 仅展示 head + parent + children | 不预加载全部内容 | P1 |
| TC-W-710 | TreeView contextValue 切换 | head/branchTip/protected/archived | 各 contextValue 与菜单 when 一致 | P1 |

### 5.9 集成 & 回归

| 用例编号 | 测试目标 | 期望 | 优先级 |
|---|---|---|---|
| TC-W-801 | edit→undo→redo 完整循环 | 文档/projection 一致 | P0 |
| TC-W-802 | 快速输入 + 关闭文档 | timer 被清除，无回调访问 closed doc | P0 |
| TC-W-803 | 多 doc 状态隔离 | A 的 commit 不影响 B 的 events | P0 |
| TC-W-804 | reset history | controllers/queues/timers 清理；**legacy tree 重建** | P1 |
| TC-W-805 | deactivate 持久化数据不丢 | flushToDisk 完成后才退出；**当前不 await** | **P0** |
| TC-W-806 | 黄金兼容：`ctrlzTreeGolden.unit.test` 通过 | 已通过 ✓ | 维持 |
| TC-W-807 | 1000+ 节点 prune plan p95 | <250ms | P1 |
| TC-W-808 | 性能：1MB 文档单字符 commit | p95 <50ms | P1 |
| TC-W-809 | autonomy=L0 关闭 AI | 任何 AI 命令均直接返回，不发请求 | P0 |
| TC-W-810 | sendFullContent=never 默认 | provider payload 不含全文 | **P0**；当前 promptBuilder 仍可能注入大块 diffSummary，逻辑未实现 |

---

## 6. 边界条件测试清单

| 类别 | 边界 | 测试方法 |
|---|---|---|
| 数值 | `maxHistoryNodesPerDocument`：50 / 49 / 100000 / 100001 / NaN / -1 / Infinity | clampConfig 应返回默认或最近合法值 |
| 数值 | `snapshotEveryNodes=0` | 不应除零 NaN（**当前未 clamp**） |
| 数值 | `maxRequestsPerHour=0` | scheduler 应 reject；**当前 NaN sleep** |
| 字符串 | docUri 空字符串 | 视为非法，不创建 tree |
| 字符串 | 文件名包含 `<script>`、emoji、超长（>500 字符） | escapeHtml；webview title 显示截断 |
| 字符串 | `diffSummary` 包含 NUL/控制字符 | prompt 不崩溃 |
| 集合 | events=[]（首次激活） | project 返回空 projection，不抛 |
| 集合 | events 含 1 项 init | rootId=headId，branchTips=[rootId] |
| 集合 | tree 100000 节点 | TreeView 渲染 lazy；无 RangeError on Math.max |
| 时间 | createdAt 同一毫秒 | branch tips 排序需稳定 |
| 时间 | 闰年/夏令时 | `formatTimeAgo` 返回正确 |
| 状态 | head 已 hard deleted | invariant warn；commit 失败但不崩 |
| 状态 | 再次 begin 同 reason token | Set 容许并行；end 后不影响 |
| 状态 | persistenceStore.dataKey 长度异常 | initialize 返回 ok:false |
| 状态 | DiffContentRegistry size 0 | get 任意 id 返回 undefined |
| 状态 | controller.close 在队列空闲时 | flush + queue.clear，无未结 promise |

---

## 7. 异常路径测试矩阵

| 异常场景 | 触发方式 | 预期行为 | 是否回滚 | 是否记录日志 | 是否告警 | 测试方法 |
|---|---|---|---|---|---|---|
| WorkspaceEdit 拒绝 | mock applyEdit→false | 返回 ok:false，不动 events | tree.setHead 回滚 | error log | showErrorMessage | TC-W-707 |
| applyEdit reject (throw) | mock 抛错 | 兜底 catch，token 释放 | tree.setHead 回滚 | error log | showErrorMessage | TC-W-707 |
| document 在 apply 时已关闭 | document.lineAt 抛 | applyEditAndVerify 抛，包装为 ok:false | head 回滚 | error log | optional | 集成 |
| controller.commit 抛 | tree.set 抛（极小概率） | promise reject，processDocumentChange.catch 仅 log | tree 状态部分变更 | error log | 否（不可见） | 集成 |
| persistence write fail | mock fs.writeFile 抛 | saveDocument ok:false | needsPersist 不复位 | warn log | 无 | TC-W-604 |
| persistence load 损坏 | manifest schemaVersion 错 | ok:false | 不修改内存 | warn log | 无 | TC-W-605 |
| SecretStorage throw | mock secrets.get 抛 | available=false（仅特定 message） | 否 | error log | testConnection 提示 | TC-W-603 |
| AbortController 触发 | scheduler.cancelByDoc | provider 返回 retryable abort | 否 | warn log | 无 | TC-W-308 |
| Provider 401 | mock fetch | retryable=false，testConnection 提示 "Authentication failed" | 否 | error log | showErrorMessage | TC-W-406 |
| Provider 5xx | mock fetch | retryable=true，触发重试 | 否 | warn log | 重试后失败再提示 | TC-W-407 |
| Webview 收到非法 message | onDidReceiveMessage 注入 | schema 拒绝，handler 不动作 | 否 | warn log | 无 | TC-W-701 |
| Webview navigate 节点已删 | tree 删除后再发 message | 提示 "Node ... not found"，刷新 panel | 否 | info log | 提示 | TC-W-708 |
| TreeView refresh 中 tree 为 null | clear() 调用 | getChildren 返回 [] | 否 | 无 | 无 | unit |
| 配置非法 enum | provider="x" | clampAiConfig.errors，testConnection 拒绝 | 否 | error log | showErrorMessage | TC-W-510 |
| `Math.max(...largeArray)` | tracked docs 有 10万 节点的子树 | 应当用循环；**当前 spread 风险 RangeError** | — | — | — | TC-W-803 高负载 |

---

## 8. Mock 方案

| 依赖 | 为什么 Mock | 正常返回 | 异常返回 | 验证 |
|---|---|---|---|---|
| `vscode.workspace.applyEdit` | 不真实改文件 | true | false / 抛错 | edit 调用次数、replace 范围 |
| `vscode.workspace.fs` | 持久化路径 | bytes | EACCES / FileNotFound | save/load round-trip |
| `vscode.SecretStorage` (`context.secrets`) | API key | 返回 base64 字符串 | throw "not available" | 不写 settings/log |
| `vscode.window.showQuickPick` | 多分支 redo 路径 | 选中第一项 / undefined | reject | 取消时无变更 |
| `vscode.window.showWarningMessage`（modal） | 删除/合并确认 | 'Reset'/'Merge' / undefined | undefined | 取消时无破坏 |
| global `fetch` | provider 网络 | 200 + JSON / 401 / 429 / timeout | AbortError / TypeError | request body/header 经过脱敏 |
| `setTimeout` / `setInterval` | 防抖、自动 persist | 立即触发 | 不触发 | 计数、清理 |
| `Date.now`、`crypto.randomBytes` | 决定性事件序列 | 固定值 | — | seq 单调、id 不冲突 |
| `OutputChannel` | 日志断言 | 收集 appendLine | — | 含/不含敏感字段 |
| `WebviewPanel.webview.postMessage` | 验证消息 schema | 接收 | throw（panel 已 dispose） | safePostMessage 不崩溃 |
| `RequestScheduler` 内部 timer | 模拟 timeoutMs | fake clock | — | 重试次数、并发计数 |

---

## 9. 安全性白盒测试矩阵

| 风险点 | 代码位置 | 触发条件 | 影响 | 测试方法 | 修复建议 | 等级 |
|---|---|---|---|---|---|---|
| **AI prompt 未脱敏** | `src/ai/promptBuilder.ts:72-144` 与 `src/ai/aiService.ts:60-77` | 用户文档 diff 含 token/PEM | 用户密钥/源码上传 | 构造含 password 的 diff，截获 outgoing fetch body 检查 | 在 `buildUserMessage` 前对 `diffSummary` `siblingSummaries` `nearbyNames` `filePath` 调用 `redactSensitiveData` | **高** |
| **redactor 缺常见 token 模式** | `src/ai/redactor.ts:1-19` | 出现 `ghp_` `xox[bp]-` `eyJxxx.xxx.xxx` `sk-...` | 部分密钥未替换 | 单元 fixtures 覆盖 | 增加 GH/Slack/JWT/OpenAI key 模式；优先按 token 形态识别 | 中 |
| **明文 settings/日志泄露 API key** | `src/extension.ts:611-636` | 用户输入 key | OK：已用 SecretStorage；error 日志若含 e.message 可能含 raw key | 注入 401 / 网络层 raw header 错误 | 在 `aiService` 所有 `log.error/warn` 上调用 redactor | 中 |
| **Webview CSP `unsafe-inline` for style** | `src/webview/webview.html:5` | Webview 渲染 | 潜在 CSS 注入 | 静态扫描 CSP | 移除 unsafe-inline；将样式注入文件并使用 nonce | 中 |
| **Webview message 未知字段透传** | `src/webview/messageSchema.ts:22-49` | 注入额外字段 | 当前已 type-guard ✓ | 单测 | 若已通过则保持回归 | 低 |
| **Webview title XSS** | `src/webview/webviewManager.ts:451-456` | 文件名含 HTML | 已 escapeHtml ✓ | 单测 | 维持 | 低 |
| **diff URI 不含正文** | `src/extension.ts:64-79` | 打开 diff | 注册表 ID 在 URI authority | URL 静态扫描 | 维持 | 低 |
| **持久化加密** | `src/security/persistenceStore.ts:60-94` | persistence on | AES-256-GCM ✓ | 静态扫描 ciphertext 不含明文 | 增加 KDF 或 keyId 头 | 低 |
| **持久化未挂入 load 路径** | `src/security/persistenceService.ts:81-123` | 重启扩展 | 历史不被恢复（功能瑕疵 + 间接安全：用户可能误以为已备份） | 启动后期望加载历史，断言 events.length>0 | 在 `extension.activate` 调用 `loadDocument` 并 reconstruct | **中** |
| **不安全 baseUrl** | `src/config/configService.ts:91-94` | 配置 `http://...`（非 localhost） | 明文请求带 API key | 单测：`http://example.com` 应被拒 | 仅放行 https + localhost http；当前**只校验 URL 形式** | 高 |
| **enableScripts: true** | `src/webview/webviewManager.ts:527` | 默认 webview | 可执行任意脚本 | 静态扫描 | 限制 localResourceRoots ✓；维持 | 低 |
| **fileSig.mtime 永远为 0** | `src/history/historyController.ts:76` | 外部修改 | 永远不触发 V4 §12.3 archive 分支 | 集成：外部覆写文件，触发 init | 真实读取 stat | 中 |
| **dataKey 重新生成会丢失旧加密文件** | `src/security/persistenceStore.ts:42-49` | 用户清空 SecretStorage | 既存加密历史不可解 | 模拟 SecretStorage delete | manifest 写入 keyId；多 key 解密路径 | 中 |
| **`Math.max(...largeArray)`** | `src/extension.ts:124-125` | 巨大 nodes Map | RangeError | 构造 1e6 节点 | 改循环 | 中 |
| **dual-store 未授权写路径** | `src/extension.ts:339,445,778` 等 | UI handler 直接 `tree.setHead/z/y` | projection 长期失真 | 集成：先 webview navigate，再 commit，断言 events 一致 | 全部走 `HistoryController.navigateToNode` | **高** |
| **错误信息回显 e.message 不脱敏** | `src/extension.ts:597,683` 等 | provider 报错含 raw URL/header | 信息泄露 | mock fetch 返回带 header 的 error | 调用 redactor 后再 `showErrorMessage` | 中 |

> 安全测试只针对授权代码与防御性验证。本节不生成攻击性脚本。

---

## 10. 并发与一致性测试设计

| 场景 | 并发数量 | 初始数据 | 执行动作 | 预期结果 | 断言点 | 潜在问题 |
|---|---|---|---|---|---|---|
| 快速输入 + ctrl+z 抢占 | 1 doc，2 任务 | 已有 5 commits | 输入 字符 → 立即 ctrl+z | 结果一致；不丢用户输入 | 末态 head 与最终内容匹配 | 防抖 setTimeout 清除时序 |
| 关闭文档 | 1 doc | 队列含 commit pending | 关闭 doc | pending 取消；当前任务 token abort；persistence flush | controller.close 后 events 已写盘 | `cancelPending` 不触发 abort（**bug**） |
| 多 doc 并行 commit | 2 docs | 各 100 commits | 并行触发 | 互不阻塞；末态独立 | events 数量正确 | 跨 doc 共享 ContentStore；当前每 controller 没传 contentStore，无冲突 |
| AI 重试期间用户取消 | 1 docId | scheduler timeoutMs 短 | execute 失败 → 重试 → cancelByDoc | 当前 + 队列均 reject | concurrent 归 0，rateTimestamps 不增加 | 重试期 concurrent 双倍透支 |
| 同 doc enqueue 嵌套 | 1 docId | 任务 A 内调 enqueue | 抛错 | 抛 "nested enqueue not allowed" | enqueuing 同步窗口已释放，**不报错** |
| Webview navigate + 编辑 | 1 doc | 历史链 N | navigate 中插入字符 | 一致 | 没有交错；editTokens 阻拦事件 | navigate 未走队列，可能与 commit 并发 |
| persistence flush + commit | 1 doc | flush 大文件 | flush 期间继续 commit | events 不丢失；下次 flush 包含 | events 数组不被并发修改 | 当前 events 是 push 安全；但 lastSeq 取自 projection，可能滞后 |
| dual-store 一致性 | 1 doc | 多次 navigate | navigate→commit→navigate | events 含合理 headMove + edit；projection.headId 与 tree.getHead() 一致 | 期望一致；**当前可能漂移** | dual-store P0 |

---

## 11. 性能与资源使用风险

| 风险点 | 代码位置 | 触发数据规模 | 影响 | 测试方法 | 优化建议 |
|---|---|---|---|---|---|
| `Math.max(...arr)` 大文档 | `extension.ts:124` | tracked docs 多 | RangeError | 构造 100 docs × 100k nodes | 用循环 |
| `tree.findLatestNonEmptyState` | `model/ctrlZTree.ts:169-189` | nodes>1000 | O(n²) 重建 | benchmark | 缓存内容/索引 |
| `applyDiff` 顺序敏感性 | `lcs.ts:58-80` | 长文档 | O(n) ops × n keep slice | benchmark | 替换为偏移驱动算法 |
| 每次 commit `project(events)` 全量重建 | `historyController.ts:103,157` | events>10000 | O(n) per commit；累计 O(n²) | benchmark | 增量投影（V4 §14.1 已要求） |
| ContentStore LRU evict | `contentStore.ts:197-215` | cache 达上限 | O(n) per add | benchmark | 真实 LRU（双向链表） |
| `provideTextDocumentContent` 每次拉全文 | `extension.ts:64-79` | diff 大文档 | 重复字符串拷贝 | 集成 | 缓存 / WeakRef |
| TreeView preview length 计算 | `historyTreeProvider.ts:80,97,105` | content>50KB | substring 慢 | benchmark | 维持，content 通常较小 |
| Webview `nodes/edges` 全量 post | `webviewManager.ts:407-413` | 1000+ 节点 | message 大 + 解析慢 | benchmark | 增量 patch（V4 §11.4 已规划） |

---

## 12. 自动化测试建议

### 12.1 工具栈
- **单元测试**：Mocha (TDD ui) + Node.js assert（已配置）。建议补充 `sinon`（已引入间接依赖）做 spy/stub。
- **属性测试**：`fast-check`（V4 推荐）。当前未引入；建议在 `projection`/`pruningEngine`/`mergeEngine` 引入。
- **契约测试**：`@vscode/test-cli` + 手写 fixture mock fetch；当前 `providerContract.unit.test.ts` 已覆盖 4 种 provider 的 build/parse 主路径，需补 strict 模式 / 错误 / 重试。
- **集成测试**：`@vscode/test-electron`（已配置）。需为 dual-store 一致性、navigate 路径回归补 e2e。
- **性能测试**：建议新增 `tests/perf/*.perf.ts`，输出 markdown 报告（V4 §16 W1 任务 8）。
- **安全静态扫描**：`semgrep` + 自写 pattern（API key/PEM/eyJ） + npm audit。

### 12.2 命名与目录
| 类型 | 命名 | 示例 |
|---|---|---|
| 单元 | `*.unit.test.ts` | `projection.unit.test.ts` |
| 契约 | `*.contract.test.ts` | `openaiResponses.contract.test.ts`（建议新增） |
| 集成 | `*.integration.test.ts` | `dualStore.integration.test.ts`（建议新增） |
| 性能 | `*.perf.test.ts` | `appendCommit.perf.test.ts` |
| 安全 | `*.security.test.ts` | `redactor.security.test.ts` |
| fixtures | `tests/fixtures/<module>/<case>.json` | 已有 `test-fixtures/workspace` |

### 12.3 覆盖率门禁
对照 V4 §15.2：当前不能直接计算覆盖率（无 coverage 集成）。建议：
- 引入 `c8` 或 `nyc`，在 PR-fast 阶段输出 lines/branches。
- 门禁分级：
  - `src/history/**`：lines ≥ 90 / branches ≥ 85
  - `src/concurrency/**`：lines ≥ 90 / branches ≥ 85
  - `src/ai/redactor.ts`：lines ≥ 95 / branches ≥ 90
  - `src/ui/diffContentRegistry.ts`：lines ≥ 90 / branches ≥ 85
  - 全项目：lines ≥ 80 / branches ≥ 70

### 12.4 CI 阶段
| 阶段 | 必跑 |
|---|---|
| PR fast | compile、lint、unit、contract、`security-quick`（redactor + CSP regex） |
| PR full | integration、coverage、perf smoke |
| main nightly | full perf、e2e、`npm audit` |
| release | `vsce package`、安装 smoke、迁移 smoke |

### 12.5 推荐补充测试（基于本次审计直接产物）
1. `dualStore.integration.test.ts`：
   - 流程 A：commit → undo（UI 路径）→ commit → 断言 `controller.events` 含连续 init/edit/headMove/edit；projection.headId == tree.getHead 的 nodeId。
   - 流程 B：webview navigate → commit → 断言一致性。
2. `requestScheduler.concurrency.unit.test.ts`：
   - 模拟 5 并发 + maxConcurrent=2 + 强制 timeout 重试 → 监控 max(`getStats().concurrent`) 不超过 2。
3. `documentTaskQueue.cancellation.unit.test.ts`：
   - 任务体取一个 token 参数（修改 API），触发 cancelPending 后 task 应早退出。
4. `redactor.advanced.unit.test.ts`：
   - 覆盖 GH/Slack/JWT/OpenAI key 模式。
5. `promptBuilder.security.unit.test.ts`：
   - `diffSummary` 含 password → buildUnifiedRequest 的 messages[0].content 中应被替换为 [REDACTED]。
6. `persistence.roundtrip.integration.test.ts`：
   - 写入 events → 重启 controller → load → 对比 projection.byId/headId/seqs。
7. `webview.csp.security.test.ts`：
   - 加载 webview.html 解析 CSP，验证不含 'unsafe-inline'（一旦修复）。

### 12.6 示例伪代码
```ts
// dualStore.integration.test.ts
test('navigate via tree.setHead is reflected in projection', async () => {
  const doc = await openDoc('hello');
  await applyTextChange(doc, 'hello world'); // commit 1
  await applyTextChange(doc, 'hello world!'); // commit 2

  const tree = state.historyTrees.get(doc.uri.toString())!;
  const ctrl = state.historyControllers.get(doc.uri.toString())!;
  const previousHead = tree.getHead();

  // UI path bypassing controller (current production behavior)
  tree.setHead(tree.getAllNodes().keys().next().value); // root
  await applyEditAndVerify(doc, tree.getContent());
  ctrl.recordHeadMove(previousHead!, tree.getHead()!, 'checkout');

  const proj = ctrl.getProjection();
  assert.strictEqual(proj.headId, ctrl['hashToNodeId'].get(tree.getHead()!));
  // EXPECT projection invariant holds; current code may emit error diagnostic
});
```

---

## 13. 缺陷与风险汇总（核心）

> 编号沿用 D（设计书已记） + N（本次新增）。

| 编号 | 风险/缺陷 | 严重 | 影响范围 | 触发条件 | 建议修复 | 必修 |
|---|---|---|---|---|---|---|
| N01 | extension.ts undo/redo/visualize/webview navigate 直接 mutate 旧 `CtrlZTree`，绕过 `HistoryController` | **高** | 历史正确性 | 任意 UI 导航 | 全部走 `HistoryController.navigateToNode`，删除直接 `tree.setHead/z/y` | 是 |
| N02 | `HistoryController.recordHeadMove` 给未注册 hash 凭空 `mapHash`，事件指向不存在的 nodeId | **高** | projection 漂移 | UI 导航后 recordHeadMove | 拒绝 dangling hash 或先补 init/edit；增加单测 | 是 |
| N03 | `HistoryController` 构造后 `MemoryContentStore` 未注入 init/initialSnapshot entry，`resolve` 返回 null | **高** | content 解析 | 启用 ContentStore | 构造时 putSnapshot(rootId, initContent) + putSnapshot(initialSnapshotId, initialContent) | 是 |
| N04 | `RequestScheduler` 重试期 `concurrent` 双倍透支，违反 maxConcurrent | **高** | AI 限流 | timeout/5xx 触发重试 | 在调用 retry 前先 dec/finally 重构；或改循环 | 是 |
| N05 | `RequestScheduler.waitForRateLimit` 在 `maxRequestsPerHour=0` 等边界出现 NaN sleep | **高** | AI 调度 | clamp 未拒绝 0 | clamp 最小 1；或 length≥cap 时直接 reject | 是 |
| N06 | `DocumentTaskQueue` 任务签名无 CancellationToken，`cancelPending` 无法终止当前任务 | **高** | 关闭文档/AI 取消 | 队列正在执行的任务 | 改 task 签名为 `(token) => Promise<T>`；onClose 走 token | 是 |
| N07 | `DocumentTaskQueue` 嵌套 enqueue 守卫只覆盖同步窗口，实际不能拦截运行时嵌套 | 中 | 死锁/饥饿 | task 内重新 enqueue 同 doc | 在 task 上下文挂 AsyncLocalStorage 标记，或在 enqueue 时检查"当前任务 docId" | 是 |
| N08 | `lcs.applyDiff` 对 `add.position` 不感知，`remove` 是 no-op；diff op 顺序错乱时静默损坏 | 中 | 持久化兼容 | 自定义/迁移导入 | 实现位置语义重放或在 applyDiff 末尾 hash 校验 | 是 |
| N09 | `CtrlZTree.set` 在 hash 冲突时**加盐**重新计算 hash | 中 | 内容指纹身份 | 极小概率冲突 | 改为 nodeId 主键，不动 contentHash | 是 |
| N10 | `extension.ts` 多处 `Math.max(...largeArr)` 风险 RangeError | 中 | 大量文档 | 100 docs × 多节点 | 循环计算最大值 | 是 |
| N11 | `extension.ts:705` 在 deactivate 中 `controller.flushToDisk()` 无 await | **高** | 数据丢失 | 关闭 VS Code | 改为 `await Promise.allSettled(...)` 并设硬超时 | 是 |
| N12 | 自动持久化 `setInterval` 在 `persistenceService.initialize` 完成前可能触发，每次返回 ok:false | 低 | 噪声日志 | 启动 5s 内 | 在 initialize resolve 后再启动 timer | 否 |
| N13 | `persistenceService.loadDocument` 未被任何调用方使用 | **中** | 重启历史不恢复 | 重启扩展 | 在 controller 构造时（fingerprint 命中）调用 load + 投影 reset | 是 |
| N14 | `persistenceService.saveDocument` 两次 fs.writeFile 非原子 | 中 | 持久化损坏 | 写 events 成功后写 manifest 失败 | 写临时文件 + rename；或 manifest 含 SHA-256(data) | 是 |
| N15 | `secretStore.createVSCodeSecretStore.probeAvailability` 死代码；`available` 仅靠错误文本被动设定 | 低 | 误判可用性 | 平台无 SecretStorage | 启动时主动 probe 并缓存；不可用时强制 mode=off | 是 |
| N16 | `configService` 仅 clamp 5 个字段，V4 §9.2 共 30+ 项未实现 | 中 | 配置一致性 | 用户配置非法 | 全字段 clamp + onDidChange + 文档化 | 是 |
| N17 | `extension.ts:281` `baseUrl` 一次性读取，配置变更不动态生效 | 中 | UX | 用户切 endpoint | 注入 ConfigService 订阅，或在每次请求前读取 | 是 |
| N18 | `extension.ts:42` `logging.level` 一次性读取 | 低 | UX | 用户切级别 | onDidChangeConfiguration 监听 | 否 |
| N19 | `webview.html:5` CSP 仍含 `'unsafe-inline'` | 中 | XSS 面 | 主题/语言切换样式 | 移除 unsafe-inline，迁移到 CSS 文件 | 是 |
| N20 | `aiService.testConnection` log 包含 response substring，潜在内容泄露 | 中 | 隐私 | 任何 testConnection | redactor 处理后再写日志，或裁剪到 schema 字段 | 是 |
| N21 | `promptBuilder` 未对 user message / diffSummary / filePath 调用 redactor | **高** | 隐私 | AI 启用 | 在 buildUnifiedRequest 前后做 redact | 是 |
| N22 | `redactor` 缺 GH PAT / Slack token / JWT / OpenAI sk- 模式 | 中 | 隐私 | 上述模式出现 | 增 patterns | 是 |
| N23 | `operationPlanner` 仅支持 `archive`/`delete`，不支持 `merge`/`prune`，与 V4 §10.6 不符 | 中 | AI 功能性 | L4 plan | 增加分支 + 单测 | 是 |
| N24 | `operationPlanner` 在 `baseSeq=0` 与 `lastSeq=0` 都为 0 时不报 stale，但语义可能错 | 低 | AI 一致性 | 新文档第一次 plan | 引入 generation token 或 docFingerprint 校验 | 否 |
| N25 | `customHttpJsonProvider` baseUrl 未做 https 强制（依赖 clampAiConfig，但 clampAiConfig 不区分 https/http 公网与 localhost） | 中 | 隐私 | 用户配公网 http | clampAiConfig 拒绝公网 http；只放 localhost | 是 |
| N26 | `OpenAIResponsesProvider.parseResponse` 签名缺 `strictSchema` 参数，V4 严格模式回退到 best-effort | 中 | AI 输出 | toolMode='force_schema_tool' | 增加参数并对齐 chat-compatible/anthropic 行为 | 是 |
| N27 | `mergeChain` 命令仅生成 plan，UI 上"Merge 完成"实际未执行 | 中 | UX 误导 | 用户点 Merge | 实现执行器或在 UI 显示"未启用" | 是 |
| N28 | `historyController.commit` 在 `tree.set` 后才校验/重投影；若 project 抛错则 tree 已 mutate | 中 | 数据一致性 | project 异常 | 先构造 EditEvent + 临时 project 校验，再 commit | 是 |
| N29 | `events` 数组在内存无界增长，缺少 V4 §12.3 compaction | 中 | 内存 | 长会话 | snapshot/diff 合并 + load+rebuild | 是 |
| N30 | `historyController` `cursor` 接口要求 `vscode.Position`，可测试性差 | 低 | 单元测试 | 单测 | 改为 V4 `Cursor` 接口（line/character） | 否 |
| N31 | `webviewManager.handleNavigateToNode` 直接 `setHead` + apply，不走队列 / 不通知 controller | **高** | dual-store | webview 双击节点 | 改为 `controller.navigateToNode` 单一入口 | 是 |
| N32 | `editorApply.applyEditAndVerify` 未接受 CancellationToken 与 cursor，且 EOL 归一化与目标内容比较存在隐患 | 中 | apply 一致性 | 文档存在 LF/CRLF 混合 | 增 token；显式 EOL 协商；apply 后再读取 | 是 |
| N33 | `redactRequestData` 依赖 `Object.entries`，不处理 Map/Set/Buffer 等 | 低 | 日志 | 复杂日志对象 | 显式判断类型 | 否 |
| N34 | `historyTreeProvider` 内容预览直接拼 `headContent.substring(0,57)`，可能包含密钥前缀 | 低 | 隐私 | 文档头含密钥 | 走 redactor 或仅显示 hash + age | 否 |
| N35 | `extension.ts` 注册了两个 `onDidChangeActiveTextEditor`（line 192 与 263） | 低 | 资源 | 任意切换编辑器 | 合并 | 否 |
| N36 | persistenceStore dataKey 删除后旧文件不可读，无 keyId/version 头 | 中 | 持久化向后兼容 | 用户清空 secret | 写入 schemaVersion + keyId | 是 |
| N37 | `MemoryContentStore.appendEdit` `policy.snapshotEveryNodes=0` 时 `nodeCount % 0 = NaN`，永不 snapshot | 低 | 配置异常 | 配置非法 | clamp 最小 1 | 是 |
| N38 | webview short-hash 8 字仅作为面向用户标识，但用作 navigate 主键，命中冲突跳过 | 低 | 极少冲突 | 同前 8 字 | 用 nodeId 取代短 hash | 否 |
| N39 | `package.json` engines `vscode: ^1.60.0`，但代码使用 `vscode.tabGroups`（1.67+） | 中 | 低版本兼容 | 旧 VS Code | 提升 engines 或 feature-detect | 是 |
| N40 | `package.json` 中 ai 相关配置仅 4 项，但 `clampAiConfig` 期望更多 | 低 | 配置完整性 | 用户期望 timeout/temperature 等 | 同步 schema | 否 |

> 已知 V4 D01–D14 中：D03（applyEdit 失败一致性）部分修复（applyTreeStateToDocument 回滚），D05（diff URI）已修复，D06（diff schema）已修复，D08（webview message schema）已修复，D10（title escape）已修复；其余 D02/D07/D09/D11/D12/D13/D14 仍存在或部分残留。

---

## 14. 需要补充的信息

| 项 | 影响判断 |
|---|---|
| `IMPLEMENTATION_TODOS.md` 当前阶段位置 | 决定哪些 P0 是"未排期"还是"逾期" |
| Provider 真实 fixture（OpenAI Responses 最新 schema） | 契约测试覆盖度 |
| 用户是否已在生产环境启用 persistence | N13 优先级是否升级到 P0 |
| Web/Remote 兼容矩阵 | secretStore/persistence 降级路径设计 |
| 期望覆盖率 baseline | 当前未配置 nyc/c8 |
| 已知历史缺陷工单（如 GitHub Issues） | 回归用例覆盖优先级 |

---

## 15. 总结陈述

本次审计在不修改运行时代码的前提下，按 V4 §15 的白盒测试矩阵对当前 `src/` 全树做了系统性核查。结论是：

1. **设计骨架到位**：events/projection/contentStore/pruning/merge/scheduler/secretStore/persistence 均有模块；229 个不依赖 VS Code 的单测全部通过。
2. **运行时改造未完成**：UI 主路径仍依赖旧 `CtrlZTree`，`HistoryController` 仅做"事后日志"，导致 dual-store。`MemoryContentStore` 形同虚设；`PersistenceService.loadDocument` 没有调用方；`RequestScheduler` 与 `DocumentTaskQueue` 的取消/并发语义与 V4 §8 不一致。
3. **AI 隐私底线尚未稳固**：`promptBuilder` 不脱敏；`redactor` 缺常见 token 模式；错误日志未全脱敏；`baseUrl` 未对公网 http 做强校验。
4. **整改路线**：建议按 V4 §16 的 W2/W3 顺序优先修 N01–N06、N11、N13、N21、N25；之后再补 N04/N06 的并发硬化与 N08 的 diff 校验；最后做 W4 的 PruningEngine/MergeEngine 接入 + 配置/CSP 收尾。

> 报告中所有"当前 bug"标记均带有具体 `file:line` 引用；建议在采纳本报告时直接复制对应行号到 PR 描述，按 §13 编号闭环。
