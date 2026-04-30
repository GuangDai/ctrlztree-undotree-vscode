# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
   - `events.ts` — Append-only event types (Init, Edit, HeadMove)
   - `projection.ts` — Pure projection from event log to graph state (NodeId, parentOf, childrenOf, headId, etc.)
   - `historyController.ts` — Bridges legacy `CtrlZTree` with the new event log + projection model. Manages commit/undo/redo/checkout/close lifecycle and persistence. Serializes writes through `DocumentTaskQueue`.
   - `contentStore.ts` — Content storage with snapshot/diff/LRU strategies
   - `mergeEngine.ts`, `pruningEngine.ts`, `deleteEngine.ts`, `operationPlan.ts` — History mutation operations (W4)

3. **Change Tracking** (`src/services/changeTracker.ts`) — Subscribes to `onDidChangeTextDocument`, applies smart debounce with grouping logic (pauses > threshold create new snapshots; whitespace/newline triggers immediate flush). Routes changes through `HistoryController.commit()` when available.

4. **Diff Engine** (`src/lcs.ts`) — LCS-based diff with serialize/deserialize/apply. Diff data is deterministic and schema-validated. Invalid diffs fail closed.

5. **Webview Visualization** (`src/webview/`) — Interactive tree graph using vis-network. Webview HTML/CSS/JS in `webview.html`, `webview.js`, `webview.css`. `webviewManager.ts` handles lifecycle, graph protocol, message dispatching with schema validation. CSP is tight; all HTML text is escaped. Uses `retainContextWhenHidden: false` for memory optimization.

6. **TreeView UI** (`src/ui/`) — `historyTreeProvider.ts` provides data for the sidebar TreeView. `diffContentRegistry.ts` registers original/modified content pairs for diff editor display via a custom `ctrlztree-diff:` URI scheme.

7. **AI Pipeline** (`src/ai/`) — Provider-based AI with `ProviderRegistry`, `RequestScheduler`, `SecretStorage`-backed API keys, redaction, and operation planning. Four providers: `openai-chat-compatible`, `openai-responses`, `anthropic-messages`, `custom-http-json`. AI must never directly mutate history — all operations go through `OperationPlanner` validation.

8. **Concurrency** (`src/concurrency/`) — `DocumentTaskQueue` (per-document write serialization), `ApplyEditTokenSet` (self-triggered edit suppression), `RequestScheduler` (AI request concurrency/retry/cancellation).

9. **Security** (`src/security/`) — `SecretStore` wraps VS Code `SecretStorage`. `PersistenceService` provides AES-GCM encrypted event log persistence with fingerprint-based file naming.

### Extension Entry Point

`src/extension.ts` — Activation wires everything together: creates tree state, document queue, controllers, change tracker, webview manager, TreeView provider, AI pipeline, and registers all commands and keybindings. The `activate()` function is the integration surface.

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
| `src/history/**` | Pure core logic, no VS Code imports. Use events, projection, explicit result types. |
| `src/model/ctrlZTree.ts` | Legacy compatibility only. Do not deepen hash identity model. |
| `src/lcs.ts` | Deterministic, schema-validated. Performance changes need benchmarks. |
| `src/concurrency/**` | Owns task queues, apply tokens, cancellation. No ad-hoc locks elsewhere. |
| `src/config/**` | All config defaults, clamps, enum validation. No scattered config reads. |
| `src/ai/**` | No plaintext keys, no implicit providers, no direct history mutation. |
| `src/ai/providers/**` | Provider adapters only. No UI, no direct VS Code settings/SecretStorage. |
| `src/webview/**` | All messages untrusted. Schema-guard, escape text, tight CSP. |
| `src/services/**` | Thin adapters. New async writes go through `DocumentTaskQueue`. |
| `src/utils/**` | Small reusable helpers. State transition logic belongs in history/concurrency. |

### Commit Convention (from AGENTS.md)

Format: `<phase>/<todo>: <imperative summary>` with Why/What/Validation sections. Each commit is scoped to one V4 phase or tightly related fix. The branch follows V4 architecture phases W1 through W10.
