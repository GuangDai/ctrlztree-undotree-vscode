# AGENTS.md

This file defines the working rules for AI agents and human collaborators in this repository.

Primary language for project discussions is Chinese unless the user requests otherwise. Code, identifiers, comments, commit messages, and documentation may remain English where that matches the existing project style.

## Source Of Truth

`UPGRADE_DESIGN_PLAN-V4-CodeX.md` is the final and only execution baseline for the 2.x/3.x upgrade.

Older documents are historical inputs only:

- `UPGRADE_DESIGN_PLAN.md`
- `UPGRADE_DESIGN_PLAN-V2-Claude.md`
- `UPGRADE_DESIGN_PLAN-V3-CodeX.md`
- `WHITEBOX_TEST_PLAN.md`

If an older document conflicts with V4, follow V4. If V4 does not cover a case, decide by these principles:

- Safety by default.
- Verifiability before feature expansion.
- Performance claims must have benchmarks.
- AI must not directly execute destructive history operations.
- Do not introduce implicit model channels, plaintext secrets, or plaintext persisted history.

## Hard Product Decisions

These decisions are frozen unless the user explicitly reopens the design:

| Area | Decision |
|---|---|
| History core | Append-only event log + pure projection + ContentStore with snapshot/diff/LRU. Migrate in phases through a legacy adapter. |
| Node identity | Use per-document monotonic `NodeId`; `ContentHash=sha256(content)` is only a content fingerprint. Do not use short hashes as stable identity. |
| AI providers | Only user-managed `openai-responses`, `openai-chat-compatible`, `anthropic-messages`, and `custom-http-json`. |
| Forbidden AI paths | Do not integrate Copilot. Do not use `vscode.lm`. Do not probe implicit model channels. Do not use any model fallback not explicitly configured by the user. |
| API keys | Store only in VS Code `SecretStorage`. Never write keys to settings, logs, Webview messages, persisted history, exports, errors, or tests fixtures. |
| Persistence | Default mode is `ask`. If enabled, persistence must be AES-GCM encrypted. No production plaintext persisted history or plaintext export. |
| AI actions | AI may generate names, summaries, structured suggestions, and operation plans. Destructive merge/delete/prune/cleanup actions require human confirmation. |
| UI | TreeView is the primary UI. StatusBar, QuickPick, Diff Editor, Hover, and Webview are supporting surfaces. |
| Concurrency | Use `DocumentTaskQueue`, `ApplyEditTokenSet`, and `RequestScheduler`. Do not add scattered ad hoc locks. |

## Implementation Order

Follow V4 phase gates. Do not skip W1/W2 to build AI or large UI features.

1. W1 Toolchain + P0 safety fixes:
   - Restore compile/lint/test harness.
   - Add `DiffContentRegistry`.
   - Add Webview message schema guards.
   - Add `ConfigService` runtime clamp.
   - Add strict diff schema validation.
2. W2 Consistency and transaction path:
   - Add `HistoryController` entry points where appropriate.
   - Add `ApplyEditTokenSet`.
   - Add `applyEditAndVerify`.
   - Ensure apply false/reject does not commit head moves.
3. W3 Event log foundation:
   - Add events/projection/contentStore.
   - Add legacy adapter and golden tests.
4. W4 History operations:
   - Add merge/delete/prune operation plans.
   - Archive before hard delete.
   - Add property tests for graph invariants.
5. W5 TreeView primary UI.
6. W6 encrypted persistence.
7. W7 Webview graph protocol and benchmark-driven renderer decision.
8. W8 AI providers and operation planner.
9. W9 compatibility and stress hardening.
10. W10 release docs and migration notes.

## Task Entry Playbooks

Use these playbooks to decide what to do when a request is ambiguous.

| User request | Default agent behavior |
|---|---|
| "start implementing", "开始生成", "开始做" | Start from the earliest incomplete V4 phase, normally W1/W2. Do not jump to AI, persistence, or full UI rewrite. |
| "fix safety/security" | Prioritize URI content isolation, Webview schema guards, HTML escaping, SecretStorage, redaction, and encrypted persistence. |
| "make it faster" | First add or run a benchmark. Then optimize the measured bottleneck. Do not claim performance improvement without numbers. |
| "add AI" | Verify or implement SecretStorage, Redactor, RequestScheduler, ProviderRegistry, schema validation, and operation approval first. |
| "support custom endpoint/model" | Implement through the Provider abstraction only. Require explicit endpoint/baseUrl/model and SecretStorage key. |
| "add pruning/delete/merge" | Generate operation plans first, then preview, validate invariants, require confirmation where destructive, and prefer archive. |
| "improve tree UI" | Prefer TreeView, context menus, QuickPick, Diff Editor, StatusBar. Use Webview only for graph/batch preview. |
| "persist history" | Implement encrypted persistence only. If SecretStorage is unavailable, disable and explain; never fallback to plaintext. |
| "review this change" | Use the review priorities below. Findings first, with file/line references. |
| "quick fix" | Still respect hard product decisions. Small changes must not introduce new bypasses or hidden debt. |

Before modifying code, identify:

- Which V4 phase the work belongs to.
- Which risk IDs or P0/P1 defects it addresses.
- Which files are in scope.
- Which tests or verification commands will be run.
- Which git branch/commit scope will capture the work.

## Git Discipline

Every stage, every TODO, and every meaningful implementation step must be traceable in git. This is mandatory, not optional. Do not skip git hygiene to move faster.

Required practice:

- Start each TODO by checking `git status --short`.
- Keep each commit scoped to one V4 phase/TODO or one tightly related fix.
- Do not mix unrelated refactors, formatting churn, generated files, and behavior changes in one commit.
- Do not include unrelated user changes in your commit.
- Do not revert user changes unless explicitly asked.
- After edits, review the diff before finalizing: `git diff` for working tree, or equivalent.
- Before asking for review or reporting completion, provide the exact files changed and validation run.
- If a TODO cannot be committed yet because the user did not ask for commits, still keep the worktree organized and report the recommended commit boundary.

Commit message format:

```text
<phase>/<todo>: <imperative summary>

Why:
- <risk/defect/user requirement addressed>

What:
- <main change 1>
- <main change 2>

Validation:
- <command/test run>
- <command/test not run and reason>
```

Examples:

```text
W1/W1.7: validate serialized diff operations

Why:
- Closes V4 D06/R09 by rejecting corrupt diff operations.

What:
- Adds strict DiffOperation guards.
- Adds invalid diff fixtures for malformed keep/add/remove ops.

Validation:
- npm run compile
- npm test
```

```text
W2/W2.2: verify workspace edits before moving history head

Why:
- Closes V4 R02 by preventing document/tree divergence on applyEdit failure.

What:
- Adds applyEditAndVerify.
- Updates undo/redo navigation to commit only after verification.

Validation:
- npm run compile
- Targeted editor apply tests
```

Commit summaries must be specific. Avoid lazy messages such as:

- `fix`
- `update`
- `wip`
- `changes`
- `misc`
- `refactor`
- `final`
- `docs`

If the commit is documentation-only, still identify the document and purpose, for example:

```text
W0/docs: add implementation TODO checklist
```

## Current Repository Shape

Important current files:

- `src/extension.ts`: activation, command registration, global state wiring, undo/redo/visualize.
- `src/model/ctrlZTree.ts`: legacy hash-based history tree.
- `src/lcs.ts`: diff/apply/serialization/summary logic.
- `src/services/changeTracker.ts`: document change tracking and debounce.
- `src/webview/webviewManager.ts`: Webview lifecycle, message handling, navigation, diff.
- `src/webview/webview.js`, `src/webview/webview.html`, `src/webview/webview.css`: graph UI.
- `src/utils/editorState.ts`: dirty-state cleanup helper.
- `src/state/extensionState.ts`: extension state maps/sets.
- `src/test/suite`: current VS Code test suite, currently minimal.

Expected future module layout is defined in V4 Section 5. Do not create unrelated architecture outside that layout without updating V4 or asking the user.

## Directory-Level Rules

Apply these rules by path.

| Path | Rules |
|---|---|
| `src/history/**` | Pure core logic first. Avoid VS Code imports. Use events, projection, content refs, and explicit result types. Add unit/property tests. |
| `src/model/ctrlZTree.ts` | Treat as legacy compatibility code. Do not deepen the hash identity model except for short-term bug fixes. Prefer new history modules for new architecture. |
| `src/lcs.ts` | Keep diff/apply deterministic and schema-validated. Invalid operations must fail closed, not be ignored. Performance-sensitive changes need benchmarks. |
| `src/concurrency/**` | Own task queues, apply tokens, cancellation, and request scheduling. Do not add global boolean locks elsewhere. |
| `src/config/**` | All config defaults, clamps, enum validation, and change notifications live here once introduced. No direct scattered config reads in new code. |
| `src/ai/**` | No plaintext keys, no implicit providers, no direct history mutation. All output must be schema-validated and routed through OperationPlanner. |
| `src/ai/providers/**` | Provider adapters only. No UI, no direct VS Code settings reads, no direct SecretStorage writes beyond injected interfaces. |
| `src/ui/**` | UI adapters only. Do not own business state. Use projection snapshots and controller commands. |
| `src/webview/**` | Treat all messages as untrusted. Guard schema, escape text, keep CSP tight, and avoid source content payloads. |
| `src/services/**` | Services should become thin adapters. New async write work should flow into `DocumentTaskQueue`. |
| `src/utils/**` | Small reusable helpers only. If a helper controls state transitions, it belongs in history/concurrency/controller modules. |
| `src/test/**` | Tests should be meaningful and tied to V4 risks. Do not leave sample-only tests as the only coverage for changed code. |
| `resources/**` | Any bundled asset must have a clear source/version/update story. Prefer removing heavy graph dependencies only after benchmark gates. |
| `package.json` | Keep commands, configuration, activation events, and contributes aligned with V4. New settings need runtime clamp in `ConfigService`. |

## Change Type Rules

Use this matrix to decide required tests and review depth.

| Change type | Required checks |
|---|---|
| Diff or content reconstruction | Unit tests for add/remove/replace/empty/Unicode/invalid schema; performance test for large input if complexity changes. |
| History graph mutation | Unit + property/invariant tests for head, parent/children, branch tips, protected/archive/delete semantics. |
| Undo/redo/checkout/navigation | Integration or controller tests proving apply false/reject does not commit head moves. |
| Webview message handling | Negative tests for malformed payloads and unknown commands. |
| HTML/template/CSP | Escape tests and CSP inspection. |
| Config changes | Clamp tests for min/max/NaN/invalid enum and dynamic update behavior if relevant. |
| AI provider mapping | Contract fixture for request and response; timeout/error redaction test. |
| Redaction | Explicit tests containing API keys, passwords, private keys, URL tokens, and cloud credentials. |
| Persistence | Encrypted round-trip, corrupt file, SecretStorage unavailable, quota cleanup, and no plaintext scan. |
| Queue/scheduler | Ordering, cancellation, concurrency limit, timeout, retry, and document close behavior. |
| Performance optimization | Baseline before and after, with p50/p95 or clear measured output. |
| Public command/package change | VS Code integration smoke or documented reason it cannot run locally. |

## Safety Rules

Never introduce:

- Copilot integration.
- `vscode.lm` integration.
- API key settings fields.
- Plaintext API key files.
- Plaintext persisted history in production.
- Plaintext history exports in production.
- Diff/source content embedded in URI query strings.
- Webview HTML insertion without escaping.
- Webview message execution without schema/type guards.
- AI direct execution of merge/delete/prune.
- Silent best-effort repair of invalid AI operation plans.
- `eval`, shell execution, dynamic code loading, or command execution based on workspace content.

When SecretStorage is unavailable:

- Disable AI key saving.
- Disable AI providers.
- Disable encrypted persistence.
- Show a safe user-facing explanation.
- Do not fallback to plaintext.

Concrete forbidden examples:

```ts
// Forbidden: API key in configuration.
vscode.workspace.getConfiguration('ctrlztree').get('ai.apiKey');

// Forbidden: source content in URI query.
vscode.Uri.parse(`ctrlztree-diff:file?${encodeURIComponent(content)}`);

// Forbidden: direct execution from AI output.
if (aiPlan.operation === 'delete') {
  deleteNodes(aiPlan.targetIds);
}

// Forbidden: new global boolean lock.
let isApplyingEdit = false;
```

Preferred patterns:

```ts
// Preferred: injected secret store.
const apiKey = await secretStore.getProviderKey(providerId);

// Preferred: opaque diff content id.
const diffId = diffContentRegistry.register({ original, modified });

// Preferred: AI plan validation and confirmation.
const plan = operationPlanner.validate(aiOutput, projection);
await confirmDialogs.confirmDestructivePlan(plan);

// Preferred: scoped edit token.
const token = applyEditTokens.begin(docId, 'checkout');
try {
  await applyEditAndVerify(...);
} finally {
  applyEditTokens.end(token);
}
```

## AI Provider Rules

Provider implementation must go through a common registry and capability model.

Supported provider names:

- `openai-responses`
- `openai-chat-compatible`
- `anthropic-messages`
- `custom-http-json`

Provider requirements:

- User explicitly configures endpoint/baseUrl and model.
- API key is retrieved from `SecretStorage`.
- Request bodies are built through `PromptBuilder`.
- Sensitive data passes through `Redactor`.
- Responses are validated against strict JSON schema.
- Provider errors are redacted before logging or display.
- Timeouts, retries, rate limits, and cancellation go through `RequestScheduler`.

AI output rules:

- Invalid schema: fail closed.
- Stale `baseSeq`: fail closed.
- Unknown node id: fail closed.
- Destructive operation: show preview and require confirmation.
- High risk operation: require extra confirmation or reject.

Provider implementation checklist:

- Define provider capability flags before mapping fields.
- Omit unsupported optional fields instead of sending guessed parameters.
- Use `AbortController` or equivalent cancellation.
- Treat non-2xx HTTP as structured provider errors.
- Redact request and response before logging.
- Store no provider response containing source text unless explicitly approved and encrypted.
- Keep fixtures free of real keys, private URLs, and proprietary code.

## Persistence Rules

Persistence must follow V4 Section 12.

- Default: `ask`.
- Enabled: AES-GCM encrypted files only.
- Key material: VS Code `SecretStorage`.
- `untitled:`, `output:`, `git:`, `vscode-notebook-cell:`, and `ctrlztree-diff:` must not be persisted.
- Exports must be encrypted JSON packages.
- Imports must be schema-validated before use.
- File fingerprints must avoid exposing raw paths.
- Quota cleanup must compact first, then archive/prune, then prompt.

Persistence implementation checklist:

- Generate or retrieve data key from SecretStorage.
- Encrypt before writing to disk.
- Decrypt only inside persistence service boundaries.
- Validate manifest schema before loading.
- Archive corrupt or mismatched data instead of silently discarding it.
- Keep file names path-safe and based on fingerprints, not raw file paths.
- Add tests that scan encrypted files for known plaintext snippets.

## History And Data Model Rules

For new history-core work:

- Use append-only events.
- Keep projection pure and independent of VS Code APIs.
- Keep content topology separate from content storage.
- Use `NodeId` for identity and `ContentHash` for content fingerprint.
- Preserve head-to-root path during pruning.
- Preserve protected/named nodes.
- Prefer archive over hard delete.
- Hard delete requires confirmation and tests.
- All merge/delete/prune actions need operation plans.

Do not extend the old hash identity model except as a temporary compatibility bridge.

History invariant checklist:

- `headId` exists and is not hard deleted.
- root exists and has no parent.
- every visible non-root node has a parent.
- `childrenOf` and `parentOf` agree.
- archived nodes are restorable.
- deleted nodes are hidden from default TreeView.
- protected/named nodes survive automatic pruning.
- operation plans fail when `baseSeq` is stale.

## Concurrency Rules

Use explicit primitives:

- `DocumentTaskQueue` for per-document write serialization.
- `ApplyEditTokenSet` for self-triggered edit suppression.
- `RequestScheduler` for AI request concurrency, quotas, retries, and cancellation.

Do not:

- Add new global booleans for edit state.
- Allow same-document nested enqueue.
- Commit history head changes before `applyEditAndVerify` succeeds.
- Leave pending timers or queue tasks alive after document close/deactivate.

Concurrency checklist:

- Same-document write operations are serialized.
- Cross-document writes may proceed independently.
- Document close cancels pending work.
- Deactivate clears timers and aborts AI requests.
- Retry logic cannot duplicate committed history events.
- Queue stats are observable for diagnostics.

## UI Rules

TreeView is the default primary interaction surface.

Use:

- TreeView for browsing and operating on history.
- Context values for action visibility.
- QuickPick for simple selection.
- Diff Editor for content comparison.
- StatusBar for lightweight state.
- Webview only for complex graph visualization and batch previews.

Webview requirements:

- Validate all incoming messages.
- Escape all template text.
- Keep CSP tight.
- Do not send full source content unless necessary and explicitly designed.
- Use registry ids for diff content, not URI query content.
- Keep renderer replacement benchmark-driven; do not remove `vis-network` blindly unless the benchmark gate is satisfied.

TreeView implementation checklist:

- `TreeItem.id` uses stable `DocId:NodeId` style ids.
- `contextValue` encodes capability, not business logic.
- Commands revalidate node existence and projection sequence before executing.
- Large histories are lazy-expanded and do not render every node by default.
- Current head and protected/named nodes remain easy to find.

Webview implementation checklist:

- Incoming message type is validated before switch/dispatch.
- `webviewError` payload itself is validated before reading nested fields.
- Template substitutions are escaped unless they are trusted URIs.
- `retainContextWhenHidden` remains false unless there is a measured need.
- Graph updates use patch protocol once available.

## Configuration Rules

All configuration reads must go through `ConfigService` once that service exists.

Requirements:

- Runtime clamp for numeric values.
- Enum validation.
- Safe defaults.
- Warning logs for invalid user values.
- Dynamic change handling for AI, persistence, pruning, and view settings.

Do not rely only on `package.json` schema for runtime safety.

Config implementation checklist:

- Defaults are centralized.
- Runtime values are clamped.
- Invalid values produce warnings without crashing.
- Tests cover lower bound, upper bound, wrong type, invalid enum, and missing config.
- New settings include package schema and `ConfigService` validation in the same change.

## Testing Requirements

Use the V4 test matrix as the authoritative target.

Minimum expectations for meaningful changes:

- Pure logic changes need unit tests.
- Event/projection/prune/merge changes need property or invariant tests.
- Provider changes need contract fixtures.
- Security-sensitive changes need explicit negative tests.
- VS Code command and UI wiring changes need integration tests where practical.
- Performance claims need benchmark scripts or measured output.

Coverage goals from V4:

| Path | Lines | Branches |
|---|---:|---:|
| `src/history/**` | 90% | 85% |
| `src/concurrency/**` | 90% | 85% |
| `src/config/**` | 90% | 85% |
| `src/ai/redactor.ts` | 95% | 90% |
| `src/ai/providers/**` | 80% | 70% |
| `src/ui/diffContentRegistry.ts` | 90% | 85% |
| `src/ui/**` overall | 65% | 55% |
| Whole project | 80% | 70% |

Test naming:

| Test type | Pattern |
|---|---|
| Unit | `*.unit.test.ts` |
| Integration | `*.integration.test.ts` |
| Contract | `*.contract.test.ts` |
| Security | `*.security.test.ts` |
| Performance | `*.perf.test.ts` |
| Fixtures | `src/test/fixtures/<area>/<case>.json` or `tests/fixtures/<area>/<case>.json` after test layout migration |

Regression rule: any bug fix should add a test that fails before the fix or clearly document why that is not currently feasible.

## Commands

Current repository scripts:

```bash
npm run compile
npm run lint
npm test
```

V4 recommends adding these as the test system matures:

```bash
npm run test:unit
npm run test:integration
npm run test:contract
npm run test:security
npm run test:perf
npm run coverage
npm audit
```

If local dependencies are missing, do not claim validation succeeded. State the exact command attempted and the blocker.

Recommended verification by scope:

| Scope | Commands |
|---|---|
| Docs only | No compile required; run markdown/link checks if available. |
| Pure TypeScript logic | `npm run compile`, relevant unit tests. |
| VS Code command/UI | `npm run compile`, `npm test` or integration subset. |
| AI provider | `npm run compile`, contract tests, security tests. |
| Persistence/security | `npm run compile`, security tests, targeted unit tests. |
| Performance | Benchmark command or documented local timing script. |

## Code Style

- TypeScript strict mode is enabled; keep it clean.
- Prefer small, injectable modules over large closure-only functions.
- Keep pure logic free of VS Code imports.
- Prefer explicit result types for recoverable errors.
- Escape user-controlled text before HTML insertion.
- Avoid broad `any`; if unavoidable at API boundaries, validate immediately.
- Keep comments useful and sparse.
- Preserve existing user changes; do not revert unrelated files.

Error handling:

- Prefer explicit `Result`-style return values for expected failures.
- Throw only for programmer errors or unrecoverable corruption.
- User-facing errors must be short and redacted.
- Logs may include technical detail but must be redacted.
- Do not swallow errors that leave state ambiguous.

Comments:

- Add comments for non-obvious invariants, state transitions, or security decisions.
- Do not add comments that merely repeat the code.

## Review Priorities

When reviewing changes, prioritize:

1. State corruption and history data loss.
2. Secret/source leakage.
3. AI unauthorized or destructive behavior.
4. Async race conditions.
5. Diff corruption or invalid schema acceptance.
6. Performance regressions on large documents/history.
7. Test gaps around changed behavior.

Findings should be concrete, with file and line references.

Review output shape:

1. Findings ordered by severity.
2. Open questions or assumptions.
3. Short summary of the change.
4. Test gaps or commands not run.

If there are no findings, say so clearly and still mention residual risk.

## PR Self-Check Template

Use this checklist in PR descriptions or final implementation summaries:

```md
## V4 Phase
- Phase:
- Risks/defects addressed:
- TODO IDs:

## Scope
- Changed files:
- Out of scope:

## Git
- Branch:
- Commit(s):
- Commit message format checked:
- Unrelated worktree changes excluded:

## Safety
- [ ] No Copilot / vscode.lm / implicit model channel.
- [ ] No plaintext API key path.
- [ ] No plaintext persisted history/export.
- [ ] No source content in URI query.
- [ ] Webview payloads are schema-validated where touched.

## Tests
- Added/updated:
- Commands run:
- Commands not run and why:

## Behavior
- User-visible changes:
- Migration/compatibility notes:
```

## Final Response Expectations

When finishing work, summarize:

- What changed.
- Which V4 phase/risk it addresses.
- Which TODO ID(s) and git commit boundary it maps to.
- Current git status or remaining uncommitted files.
- What validation ran.
- What could not be validated.
- Any follow-up that is truly required.

Do not claim future phases are complete unless their phase gates and tests are actually done.

## Done Criteria

A PR or task is not done until:

- It follows the relevant V4 phase.
- It maps to explicit TODO ID(s).
- It has a clean, reviewable git boundary.
- Its commit message is complete and follows the format above, unless the user explicitly asked not to commit yet.
- It does not violate the hard product decisions.
- It includes focused tests or a clear reason tests cannot yet run.
- It does not introduce plaintext secrets or history.
- It does not add implicit model access.
- It keeps existing behavior covered by golden/regression tests when touching legacy paths.
- `npm run compile` and relevant tests pass, or blockers are explicitly documented.
