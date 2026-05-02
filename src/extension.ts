import * as vscode from 'vscode';
import { generateDiffSummary } from './lcs';
import { CtrlZTree } from './model/ctrlZTree';
import { createExtensionState } from './state/extensionState';
import { DIFF_SCHEME, ACTION_TIMEOUT, PAUSE_THRESHOLD } from './constants';
import { registerDocumentChangeTracking } from './services/changeTracker';
import { markEditorCleanIfAtInitialSnapshot } from './utils/editorState';
import { createDiffContentRegistry } from './ui/diffContentRegistry';
import { clampConfig } from './config/configService';
import { ApplyEditTokenSet, ApplyEditToken } from './concurrency/applyEditTokens';
import { applyEditAndVerify, ApplyEditResult } from './utils/editorApply';
import { HistoryTreeProvider } from './ui/historyTreeProvider';
import { createVSCodeSecretStore } from './security/secretStore';
import { ProviderRegistry, ProviderName, createDefaultCapabilities } from './ai/providers/registry';
import { buildOpenAIChatCompatibleRequest, parseOpenAIChatCompatibleResponse } from './ai/providers/openaiChatCompatibleProvider';
import { buildAnthropicMessagesRequest, parseAnthropicMessagesResponse } from './ai/providers/anthropicMessagesProvider';
import { buildOpenAIResponsesRequest, parseOpenAIResponsesResponse } from './ai/providers/openaiResponsesProvider';
import { buildCustomHttpJsonRequest, parseCustomHttpJsonResponse } from './ai/providers/customHttpJsonProvider';
import { DocumentTaskQueue } from './concurrency/documentTaskQueue';
import { HistoryController } from './history/historyController';
import { MemoryContentStore } from './history/contentStore';
import { AiService } from './ai/aiService';
import { BaseAiProvider } from './ai/providers/base';
import { RequestScheduler } from './concurrency/requestScheduler';
import { clampAiConfig } from './config/configService';
import { PersistenceService } from './security/persistenceService';
import { generateMergePlan } from './history/mergeEngine';
import { generatePrunePlan, DEFAULT_PRUNING_POLICY } from './history/pruningEngine';
import { Logger, LogLevel } from './utils/logger';
import { PromptContext, buildUnifiedRequest } from './ai/promptBuilder';
import { validateAiResponse } from './ai/operationPlanner';

const extensionState = createExtensionState();

// Helper moved to top-level so it's available to commands and initialization
function isTrackableDocument(document: vscode.TextDocument | undefined): document is vscode.TextDocument {
    return !!document && (document.uri.scheme === 'file' || document.uri.scheme === 'untitled');
}

function maxNodeTimestamp(tree: CtrlZTree): number {
    let max = 0;
    for (const node of tree.getAllNodes().values()) {
        if (node.timestamp > max) {
            max = node.timestamp;
        }
    }
    return max;
}

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('CtrlZTree');
    context.subscriptions.push(outputChannel);

    const log = new Logger(outputChannel);
    const logLevel = vscode.workspace.getConfiguration('ctrlztree').get<string>('logging.level', 'info') as LogLevel;
    log.setLevel(logLevel);
    log.info('CtrlZTree: Extension activating...');

    // Dynamic configuration change listener
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('ctrlztree.logging.level')) {
                const newLevel = vscode.workspace.getConfiguration('ctrlztree').get<string>('logging.level', 'info') as LogLevel;
                log.setLevel(newLevel);
                log.info(`CtrlZTree: Log level changed to ${newLevel}`);
            }
            if (e.affectsConfiguration('ctrlztree.persistence.mode')) {
                const newMode = vscode.workspace.getConfiguration('ctrlztree').get<string>('persistence.mode', 'off') as 'off' | 'ask' | 'on';
                handlePersistenceModeChange(newMode).catch(err =>
                    log.error(`CtrlZTree: Persistence mode change error: ${err?.message || 'Unknown'}`)
                );
            }
            if (e.affectsConfiguration('ctrlztree.treeView')) {
                historyTreeProvider.refresh();
            }
        })
    );

    const editTokens = new ApplyEditTokenSet();
    extensionState.editTokens = editTokens;

    // W8: SecretStore (created early so aiService + commands can use it)
    const secretStore = createVSCodeSecretStore(context.secrets);

    // W6: PersistenceService (encrypted history persistence)
    // Persistence mode: off (default), ask (prompt user), on (auto)
    const persistenceMode = vscode.workspace.getConfiguration('ctrlztree').get<string>('persistence.mode', 'off') as 'off' | 'ask' | 'on';
    extensionState.persistenceMode = persistenceMode;
    const persistenceService = new PersistenceService(secretStore, context);
    let persistenceReady: Promise<void> = Promise.resolve();

    if (persistenceMode === 'off') {
        log.info('CtrlZTree: Persistence disabled (mode=off).');
    } else if (persistenceMode === 'on') {
        persistenceReady = persistenceService.initialize().then(initResult => {
            if (initResult.ok) {
                extensionState.persistenceActive = true;
                log.info('CtrlZTree: PersistenceService initialized (mode=on).');
            } else {
                log.warn(`CtrlZTree: PersistenceService not available: ${initResult.error}`);
            }
        });
    } else if (persistenceMode === 'ask') {
        persistenceReady = persistenceService.initialize().then(async (initResult) => {
            if (initResult.ok) {
                // Prompt user for consent before enabling persistence
                const choice = await vscode.window.showInformationMessage(
                    'CtrlZTree can save your edit history to disk (encrypted). Enable history persistence?',
                    'Enable', 'Not Now'
                );
                if (choice === 'Enable') {
                    extensionState.persistenceActive = true;
                    log.info('CtrlZTree: User enabled history persistence.');
                } else {
                    log.info('CtrlZTree: User declined history persistence.');
                }
            } else {
                log.warn(`CtrlZTree: PersistenceService not available: ${initResult.error}`);
            }
        });
    }

    const diffContentRegistry = createDiffContentRegistry();

    const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
        private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
        readonly onDidChange = this._onDidChange.event;

        provideTextDocumentContent(uri: vscode.Uri): string {
            // URI format: ctrlztree-diff://diff/<registryId>/<side>
            // path is /<registryId>/<side>
            const parts = uri.path.split('/').filter(p => p.length > 0);
            if (parts.length !== 2) {
                return '';
            }
            const [registryId, side] = parts as [string, string];
            if (side !== 'original' && side !== 'modified') {
                return '';
            }
            if (!registryId) {
                return '';
            }
            const record = diffContentRegistry.get(registryId);
            if (!record) {
                return '';
            }
            return side === 'original' ? record.original : record.modified;
        }
    })();

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffContentProvider)
    );

    const getConfig = () => {
        const config = vscode.workspace.getConfiguration('ctrlztree');
        return clampConfig({
            enablePruning: config.get<unknown>('enablePruning') as boolean | undefined,
            maxHistoryNodesPerDocument: config.get<unknown>('maxHistoryNodesPerDocument') as number | undefined,
            maxTrackedDocuments: config.get<unknown>('maxTrackedDocuments') as number | undefined,
        }, (msg: string) => log.warn(msg));
    };

    const getOrCreateTree = (document: vscode.TextDocument): CtrlZTree => {
        const key = document.uri.toString();
        let tree = extensionState.historyTrees.get(key);
        if (!tree) {
            tree = new CtrlZTree(document.getText());
            extensionState.historyTrees.set(key, tree);
            log.debug(`CtrlZTree: Created new tree for ${key}`);
        }

        const config = getConfig();

        if (config.enablePruning && tree.getNodeCount() > config.maxHistoryNodesPerDocument) {
            // W4: PruningEngine generates archive plan, no hard delete.
            const controller = extensionState.historyControllers.get(key);
            if (controller) {
                const proj = controller.getProjection();
                const policy = { ...DEFAULT_PRUNING_POLICY, maxNodes: config.maxHistoryNodesPerDocument };
                const plan = generatePrunePlan(proj, policy);
                if (plan.archive.length > 0 || plan.delete.length > 0) {
                    log.info(`CtrlZTree: Pruning ${plan.archive.length} archive + ${plan.delete.length} delete for ${key} (${tree.getNodeCount()} nodes, max ${config.maxHistoryNodesPerDocument})`);
                    // Archive nodes from legacy tree by keeping them in Map but marking archived in projection
                    for (const nodeId of plan.archive) {
                        proj.archivedNodes.add(nodeId);
                    }
                    // Hard delete requested nodes that were previously archived
                    for (const nodeId of plan.delete) {
                        proj.deletedNodes.add(nodeId);
                    }
                    // Mark controller for persistence update
                    controller.setNeedsPersist(true);
                }
            } else {
                log.warn(`CtrlZTree: Pruning needed for ${key} but no controller available - nodes retained.`);
            }
        }

        // Clean up old histories if too many documents are tracked (only if pruning enabled)
        if (config.enablePruning && extensionState.historyTrees.size > config.maxTrackedDocuments) {
            const entries = Array.from(extensionState.historyTrees.entries());
            const openUris = new Set(vscode.workspace.textDocuments.map(d => d.uri.toString()));
            const entriesToDelete = entries
                .filter(([uri]) => !openUris.has(uri))
                .sort((a, b) => {
                    const treeA = a[1];
                    const treeB = b[1];
                    const timeA = maxNodeTimestamp(treeA);
                    const timeB = maxNodeTimestamp(treeB);
                    return timeA - timeB; // Oldest first
                })
                .slice(0, extensionState.historyTrees.size - config.maxTrackedDocuments);

            for (const [uriToDelete] of entriesToDelete) {
                extensionState.historyTrees.delete(uriToDelete);
                log.debug(`CtrlZTree: Removed history for old document ${uriToDelete}`);
            }
        }

        return tree;
    };

    const documentQueue = new DocumentTaskQueue();

    const pendingControllers = new Map<string, Promise<HistoryController>>();

    const getOrCreateController = async (document: vscode.TextDocument): Promise<HistoryController> => {
        const key = document.uri.toString();
        let controller = extensionState.historyControllers.get(key);
        if (controller) {
            return controller;
        }
        // Deduplicate concurrent calls to avoid creating duplicate controllers
        const pending = pendingControllers.get(key);
        if (pending) {
            return pending;
        }
        const creationPromise = (async () => {
            try {
                const tree = getOrCreateTree(document);
                const contentStore = new MemoryContentStore();
                const deps = { docId: key, tree, queue: documentQueue, contentStore, persistenceService, logger: log };

                // Wait for persistence initialization before checking
                await persistenceReady;

                // Try to restore from persisted history if persistence is active
                if (extensionState.persistenceActive) {
                    const fp = PersistenceService.computeFingerprint(key);
                    const loadResult = await persistenceService.loadDocument(fp);
                    if (loadResult.ok && loadResult.events.length > 0) {
                        let ctrl = await HistoryController.fromPersistedEvents(deps, loadResult.events, loadResult.contentEntries);
                        extensionState.historyControllers.set(key, ctrl);
                        log.info(`CtrlZTree: Restored ${loadResult.events.length} events from disk for ${key}`);
                        return ctrl;
                    }
                }

                let ctrl = new HistoryController(deps);
                extensionState.historyControllers.set(key, ctrl);
                log.debug(`CtrlZTree: Created new HistoryController for ${key}`);
                return ctrl;
            } finally {
                pendingControllers.delete(key);
            }
        })();
        pendingControllers.set(key, creationPromise);
        return creationPromise;
    };

    // W5: TreeView provider (created early so changeTracker can refresh it)
    const historyTreeProvider = new HistoryTreeProvider();
    const historyTreeView = vscode.window.createTreeView('ctrlztree.history', {
        treeDataProvider: historyTreeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(historyTreeView);

    // Click-to-diff: selecting a node in the tree opens a diff against current state.
    // Explicit "Apply This Version" is only via right-click context menu (navigateToNode).
    historyTreeView.onDidChangeSelection(e => {
        if (e.selection.length === 1) {
            const item = e.selection[0];
            // Prefer diffWithCurrent for one-click safety; diffWithParent as fallback
            vscode.commands.executeCommand('ctrlztree.history.diffWithCurrent', item);
        }
    });

    const changeTracker = registerDocumentChangeTracking({
        context,
        outputChannel,
        state: extensionState,
        getOrCreateTree,
        getOrCreateController,
        editTokens,
        setLastValidEditorUri: uri => {
            extensionState.lastValidEditorUri = uri;
        },
        actionTimeout: ACTION_TIMEOUT,
        pauseThreshold: PAUSE_THRESHOLD,
        onDocumentCommitted: (docUri, tree) => {
            const controller = extensionState.historyControllers.get(docUri);
            historyTreeProvider.setController(controller ?? null, docUri);
        }
    });
    context.subscriptions.push(changeTracker);

    const activeEditorChangeSubscription = vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && isTrackableDocument(editor.document)) {
            const controller = extensionState.historyControllers.get(editor.document.uri.toString());
            historyTreeProvider.setController(controller ?? null, editor.document.uri.toString());
        } else {
            historyTreeProvider.clear();
        }
    });

    const documentCloseSubscription = vscode.workspace.onDidCloseTextDocument(async document => {
        const key = document.uri.toString();
        const tree = extensionState.historyTrees.get(key);
        if (tree) {
            log.debug(`CtrlZTree: Cleaning up history for closed document ${key} (${tree.getNodeCount()} nodes)`);
            extensionState.historyTrees.delete(key);
        }

        const controller = extensionState.historyControllers.get(key);
        if (controller) {
            await controller.close();
            extensionState.historyControllers.delete(key);
            log.debug(`CtrlZTree: Closed HistoryController for ${key}`);
        }

        // Also clean up related state
        extensionState.lastChangeTime.delete(key);
        extensionState.lastCursorPosition.delete(key);
        extensionState.lastChangeType.delete(key);
        extensionState.pendingChanges.delete(key);

        const timeout = extensionState.documentChangeTimeouts.get(key);
        if (timeout) {
            clearTimeout(timeout);
            extensionState.documentChangeTimeouts.delete(key);
        }

        // Clean up any lingering edit tokens for this document
        editTokens.clearForDoc(key);
        extensionState.rescheduleRetryCounts?.delete(key);
    });

    // Listen for new files opening to track them immediately
    const documentOpenSubscription = vscode.workspace.onDidOpenTextDocument(document => {
        if (isTrackableDocument(document)) {
            getOrCreateTree(document);
        }
    });

    // W6: Auto-persist timer (flushes dirty controllers to disk every 5 seconds)
    // Only started when persistence might be active (mode=on or user approved ask)
    let persistFlushInProgress = false;
    let persistTimer: ReturnType<typeof setInterval> | null = null;
    function maybeStartPersistTimer(): void {
        if (persistTimer !== null) { return; }
        persistTimer = setInterval(() => {
        if (!extensionState.persistenceActive || persistFlushInProgress) { return; }
        persistFlushInProgress = true;
        const flushes = Array.from(extensionState.historyControllers.entries())
            .filter(([_, c]) => c.getNeedsPersist())
            .map(([key, controller]) =>
                controller.flushToDisk().then(result => {
                    if (!result.ok) {
                        log.error(`CtrlZTree: Persist error for ${key}: ${result.error}`);
                    }
                }).catch(err => {
                    log.error(`CtrlZTree: Persist error for ${key}: ${err?.message || 'Unknown'}`);
                })
            );
        Promise.allSettled(flushes).finally(() => {
            persistFlushInProgress = false;
        });
        }, 5000);
    }
    // Start persist timer for on/ask modes (it gates on persistenceActive internally)
    if (persistenceMode !== 'off') {
        maybeStartPersistTimer();
    }
    extensionState.persistTimer = persistTimer;
    // Ensure timer is cleaned up even on abnormal deactivation
    context.subscriptions.push({ dispose: () => {
        if (persistTimer) {
            clearInterval(persistTimer);
            extensionState.persistTimer = null;
        }
    }});

    // Runtime persistence mode change handler — covers all 6 transitions
    async function handlePersistenceModeChange(newMode: 'off' | 'ask' | 'on'): Promise<void> {
        const prevMode = extensionState.persistenceMode;
        if (prevMode === newMode) { return; }
        extensionState.persistenceMode = newMode;

        // ENABLE: off → on | off → ask
        if (prevMode === 'off' && (newMode === 'on' || newMode === 'ask')) {
            if (!persistenceService.isAvailable()) {
                const r = await persistenceService.initialize();
                if (!r.ok) { log.warn(`CtrlZTree: PersistenceService not available: ${r.error}`); return; }
            }
            if (newMode === 'ask') {
                const choice = await vscode.window.showInformationMessage(
                    'CtrlZTree can save your edit history to disk (encrypted). Enable history persistence?',
                    'Enable', 'Not Now'
                );
                if (choice !== 'Enable') { log.info('CtrlZTree: User declined persistence.'); return; }
            }
            extensionState.persistenceActive = true;
            for (const c of extensionState.historyControllers.values()) {
                c.setNeedsPersist(true);
            }
            maybeStartPersistTimer();
            log.info('CtrlZTree: Persistence enabled at runtime.');
            return;
        }

        // ENABLE: ask → on (user never approved during activation)
        if (prevMode === 'ask' && newMode === 'on') {
            if (!extensionState.persistenceActive) {
                if (!persistenceService.isAvailable()) {
                    const r = await persistenceService.initialize();
                    if (!r.ok) { log.warn(`CtrlZTree: PersistenceService not available: ${r.error}`); return; }
                }
                extensionState.persistenceActive = true;
                for (const c of extensionState.historyControllers.values()) {
                    c.setNeedsPersist(true);
                }
                maybeStartPersistTimer();
            }
            log.info('CtrlZTree: Persistence mode changed to on.');
            return;
        }

        // DISABLE: on | ask → off
        if ((prevMode === 'on' || prevMode === 'ask') && newMode === 'off') {
            for (const c of extensionState.historyControllers.values()) {
                if (c.getNeedsPersist()) {
                    try { await c.flushToDisk(); } catch { /* best-effort */ }
                }
            }
            extensionState.persistenceActive = false;
            if (extensionState.persistTimer) {
                clearInterval(extensionState.persistTimer);
                extensionState.persistTimer = null;
            }
            log.info('CtrlZTree: Persistence disabled at runtime.');
            return;
        }

        // SOFT: on → ask (keep active, just change mode for new doc restore behavior)
        if (prevMode === 'on' && newMode === 'ask') {
            log.info('CtrlZTree: Persistence mode changed to ask. Existing documents persist; new docs will prompt.');
            return;
        }
    }

    context.subscriptions.push(activeEditorChangeSubscription, documentCloseSubscription, documentOpenSubscription);

    // Eagerly initialize trees for documents already open on startup
    vscode.workspace.textDocuments.forEach(document => {
        if (isTrackableDocument(document)) {
            getOrCreateTree(document);
        }
    });

    // Initialize TreeView for current editor
    if (vscode.window.activeTextEditor && isTrackableDocument(vscode.window.activeTextEditor.document)) {
        const tree = getOrCreateTree(vscode.window.activeTextEditor.document);
        const startupKey = vscode.window.activeTextEditor.document.uri.toString();
        const startupCtrl = extensionState.historyControllers.get(startupKey);
        historyTreeProvider.setController(startupCtrl ?? null, startupKey);
    }

    // W8: AI service pipeline
    const aiRegistry = new ProviderRegistry();
    const baseUrl = vscode.workspace.getConfiguration('ctrlztree').get<string>('ai.baseUrl', '');
    aiRegistry.register('openai-chat-compatible', new BaseAiProvider(
        'openai-chat-compatible',
        createDefaultCapabilities('openai-chat-compatible'),
        baseUrl,
        buildOpenAIChatCompatibleRequest,
        parseOpenAIChatCompatibleResponse,
    ));
    aiRegistry.register('anthropic-messages', new BaseAiProvider(
        'anthropic-messages',
        createDefaultCapabilities('anthropic-messages'),
        baseUrl,
        buildAnthropicMessagesRequest,
        parseAnthropicMessagesResponse,
    ));
    aiRegistry.register('openai-responses', new BaseAiProvider(
        'openai-responses',
        createDefaultCapabilities('openai-responses'),
        baseUrl,
        buildOpenAIResponsesRequest,
        parseOpenAIResponsesResponse,
    ));
    aiRegistry.register('custom-http-json', new BaseAiProvider(
        'custom-http-json',
        createDefaultCapabilities('custom-http-json'),
        baseUrl,
        buildCustomHttpJsonRequest,
        parseCustomHttpJsonResponse,
    ));

    const aiScheduler = new RequestScheduler();
    const aiService = new AiService({
        registry: aiRegistry,
        scheduler: aiScheduler,
        secretStore,
        logger: log,
    });

    // W5: TreeView command handlers
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.history.refresh', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && isTrackableDocument(editor.document)) {
                const controller = extensionState.historyControllers.get(editor.document.uri.toString());
                historyTreeProvider.setController(controller ?? null, editor.document.uri.toString());
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.history.navigateToNode', async (item?: { nodeHash: string }) => {
            if (!item?.nodeHash) {return;}
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isTrackableDocument(editor.document)) {return;}

            const document = editor.document;
            const tree = getOrCreateTree(document);
            const controller = await getOrCreateController(document);

            // Never navigate to empty-content nodes
            const rootHash = tree.getInternalRootHash();
            if (item.nodeHash === rootHash) {
                vscode.window.showWarningMessage('CtrlZTree: Cannot navigate to empty root node.');
                return;
            }
            const nodeContent = tree.getContent(item.nodeHash);
            if (nodeContent.length === 0) {
                vscode.window.showWarningMessage('CtrlZTree: Cannot navigate to node with empty content.');
                return;
            }

            // Use controller.checkout() for consistent event logging
            const result = await controller.checkout(item.nodeHash);
            if (!result.success) {
                vscode.window.showWarningMessage(`CtrlZTree: Could not find node ${item.nodeHash.substring(0, 8)}`);
                return;
            }

            const applyResult = await applyTreeStateToDocument(document, tree, 'checkout', editTokens, controller);
            if (!applyResult.ok) {
                const newHash = controller.getHead()!;
                const prevHash = tree.getAllNodes().get(newHash)?.parent;
                if (prevHash) {
                    await controller.checkout(prevHash);
                    applyTreeStateToDocument(document, tree, 'checkout', editTokens, controller).catch(err => {
                        log.error(`CtrlZTree: TreeView navigate rollback also failed: ${err?.message || 'Unknown'}`);
                    });
                }
                log.error(`CtrlZTree: TreeView navigate apply failed: ${applyResult.error}`);
                return;
            }
            // Invalidate stale pending changes after successful checkout
            extensionState.pendingChanges.delete(document.uri.toString());
            historyTreeProvider.refresh();

            // Close diff editors opened for this document, focus back on main editor
            const docUriStr = document.uri.toString();
            // Find which tab group contains the main document editor
            let docGroup: vscode.TabGroup | undefined;
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    const input = tab.input;
                    if (input && typeof input === 'object' && 'uri' in input) {
                        const tabUri = (input as { uri?: vscode.Uri }).uri;
                        if (tabUri && tabUri.toString() === docUriStr) {
                            docGroup = group;
                            break;
                        }
                    }
                }
                if (docGroup) { break; }
            }
            // Close diff tabs only in the document's group and the Beside group
            const groupsToClean = new Set<vscode.TabGroup>();
            if (docGroup) {
                groupsToClean.add(docGroup);
                // Also clean adjacent group (where diff was opened via ViewColumn.Beside)
                const idx = vscode.window.tabGroups.all.indexOf(docGroup);
                if (idx >= 0 && idx + 1 < vscode.window.tabGroups.all.length) {
                    groupsToClean.add(vscode.window.tabGroups.all[idx + 1]);
                }
            }
            for (const group of groupsToClean) {
                for (const tab of group.tabs) {
                    const input = tab.input;
                    if (input && typeof input === 'object' && 'uri' in input) {
                        const tabUri = (input as { uri?: vscode.Uri }).uri;
                        if (tabUri && tabUri.scheme === DIFF_SCHEME) {
                            await vscode.window.tabGroups.close(tab);
                        }
                    }
                }
            }
            // Reveal the main editor for this document
            for (const ed of vscode.window.visibleTextEditors) {
                if (ed.document.uri.toString() === docUriStr) {
                    await vscode.window.showTextDocument(ed.document, ed.viewColumn);
                    break;
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.history.diffWithParent', async (item?: { nodeHash: string }) => {
            if (!item?.nodeHash) {return;}
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isTrackableDocument(editor.document)) {return;}

            const document = editor.document;
            const tree = getOrCreateTree(document);
            const allNodes = tree.getAllNodes();
            const node = allNodes.get(item.nodeHash);
            if (!node) {
                vscode.window.showWarningMessage(`CtrlZTree: Node ${item.nodeHash.substring(0, 8)} not found. It may have been archived or removed.`);
                return;
            }
            if (!node.parent) {
                vscode.window.showInformationMessage('CtrlZTree: This node has no parent to diff against.');
                return;
            }

            const parentContent = tree.getContent(node.parent);
            const currentContent = tree.getContent(item.nodeHash);
            const parentShortHash = node.parent.substring(0, 8);
            const shortHash = item.nodeHash.substring(0, 8);
            const fileName = document.uri.path.split(/[\\/]/).pop() || 'document';

            const diffId = diffContentRegistry.register(parentContent, currentContent, fileName);
            const parentUri = vscode.Uri.parse(`${DIFF_SCHEME}://diff/${diffId}/original`);
            const currentUri = vscode.Uri.parse(`${DIFF_SCHEME}://diff/${diffId}/modified`);

            await vscode.commands.executeCommand('vscode.diff', parentUri, currentUri, `${fileName}: ${parentShortHash} ↔ ${shortHash}`, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.history.diffWithCurrent', async (item?: { nodeHash: string }) => {
            if (!item?.nodeHash) {return;}
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isTrackableDocument(editor.document)) {return;}

            const document = editor.document;
            const tree = getOrCreateTree(document);
            const nodeContent = tree.getContent(item.nodeHash);
            if (nodeContent.length === 0) {
                vscode.window.showWarningMessage('CtrlZTree: Cannot diff empty node.');
                return;
            }

            const currentContent = document.getText();
            const shortHash = item.nodeHash.substring(0, 8);
            const fileName = document.uri.path.split(/[\\/]/).pop() || 'document';

            const diffId = diffContentRegistry.register(nodeContent, currentContent, fileName);
            const nodeUri = vscode.Uri.parse(`${DIFF_SCHEME}://diff/${diffId}/original`);
            const currentUri = vscode.Uri.parse(`${DIFF_SCHEME}://diff/${diffId}/modified`);

            await vscode.commands.executeCommand('vscode.diff', nodeUri, currentUri, `${fileName}: ${shortHash} (historical) ↔ Current`, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        })
    );

    // W4: Merge linear chain command
    const mergeCommand = vscode.commands.registerCommand('ctrlztree.history.mergeChain', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isTrackableDocument(editor.document)) { return; }

        const controller = await getOrCreateController(editor.document);
        const proj = controller.getProjection();

        // Find all nodes on head-to-root path that form a linear chain (each has exactly 1 child)
        const linearChain: number[] = [];
        let cursor: number | null = proj.headId;
        while (cursor !== null && cursor !== proj.rootId) {
            const children = proj.childrenOf.get(cursor) ?? [];
            if (children.filter(c => !proj.deletedNodes.has(c) && !proj.archivedNodes.has(c)).length <= 1) {
                linearChain.push(cursor);
            } else {
                break;
            }
            const parent: number | null = proj.parentOf.get(cursor) ?? null;
            cursor = parent;
        }

        if (linearChain.length < 2) {
            vscode.window.showInformationMessage('CtrlZTree: No linear chain found to merge (need >= 2 consecutive nodes with single children).');
            return;
        }

        const plan = generateMergePlan(proj, linearChain);
        if (!plan.valid) {
            vscode.window.showWarningMessage(`CtrlZTree: Merge plan invalid: ${plan.warnings.join('; ')}`);
            return;
        }

        const choice = await vscode.window.showInformationMessage(
            `Merge ${linearChain.length} consecutive nodes into 1? (~${plan.estimatedBytesFreed} bytes freed)${plan.warnings.length > 0 ? '\nWarnings: ' + plan.warnings.join(', ') : ''}`,
            { modal: true },
            'Merge'
        );

        if (choice === 'Merge') {
            log.info(`CtrlZTree: Executing merge for ${linearChain.length} nodes on head path`);

            // Get content of the last (most recent) node in the chain as the merged result
            const resultContent = controller.getContent();
            // Execute the merge via HistoryController
            const result = controller.executeMergePlan(plan, resultContent);
            if (!result.ok) {
                vscode.window.showErrorMessage(`CtrlZTree: Merge failed: ${result.error}`);
                return;
            }

            historyTreeProvider.refresh();
            vscode.window.showInformationMessage(
                `CtrlZTree: Merged ${linearChain.length} nodes into node #${result.nodeId}.`
            );
        }
    });

    const undoCommand = vscode.commands.registerCommand('ctrlztree.undo', async () => {
        const editor = vscode.window.activeTextEditor;

        if (!editor || !isTrackableDocument(editor.document)) {
            await vscode.commands.executeCommand('undo');
            return;
        }

        const document = editor.document;
        const tree = getOrCreateTree(document);
        const controller = await getOrCreateController(document);

        const savedHead = tree.getHead();
        let navResult: { hash: string | null; content: string | null };
        try {
            navResult = await controller.undo();
        } catch (err: any) {
            log.error(`CtrlZTree: undo error: ${err?.message || 'Unknown'}`);
            vscode.window.showWarningMessage('CtrlZTree: Undo busy, try again.');
            return;
        }
        if (!navResult.hash || !navResult.content) {
            // Check if failure was from desync vs legitimate end-of-history
            if (controller) {
                const proj = controller.getProjection();
                const recentErrors = proj.diagnostics.filter(
                    d => d.severity === 'error' && (d.eventSeq ?? 0) >= proj.lastSeq - 5
                );
                if (recentErrors.length > 0) {
                    log.error(`CtrlZTree: undo failed due to internal inconsistency: ${recentErrors.map(d => d.message).join('; ')}`);
                    vscode.window.showWarningMessage('CtrlZTree: Undo failed — internal state inconsistency detected. See CtrlZTree output for details.');
                    return;
                }
            }
            log.debug('CtrlZTree: No more undo history.');
            vscode.window.showInformationMessage('CtrlZTree: No more undo history.');
            return;
        }

        const result = await applyTreeStateToDocument(document, tree, 'undo', editTokens, controller);
        if (!result.ok) {
            // Rollback: set head back to saved
            if (savedHead) {
                const failedHead = controller.getHead()!; // post-undo head position
                tree.setHead(savedHead);
                // Restore tree state without emitting a duplicate headMove event
                controller.setHeadDirectly(savedHead);
            }
            return;
        }

        await markEditorCleanIfAtInitialSnapshot(tree, document, { outputChannel });
        // Invalidate stale pending changes so debounced commits don't create phantom branches
        extensionState.pendingChanges.delete(document.uri.toString());
        historyTreeProvider.refresh();
    });

    const redoCommand = vscode.commands.registerCommand('ctrlztree.redo', async () => {
        const editor = vscode.window.activeTextEditor;

        if (!editor || !isTrackableDocument(editor.document)) {
            await vscode.commands.executeCommand('redo');
            return;
        }

        const document = editor.document;
        const tree = getOrCreateTree(document);
        const controller = await getOrCreateController(document);
        const children = tree.peekRedoChildren();

        if (children.length === 0) {
            log.debug('CtrlZTree: No more redo history.');
            vscode.window.showInformationMessage('CtrlZTree: No more redo history.');
            return;
        }

        // Single branch: use controller.redo() for consistent event logging
        if (children.length === 1) {
            const savedHead = tree.getHead();
            let navResult: { hash: string | null; content: string | null };
            try {
                navResult = await controller.redo(children[0]);
            } catch (err: any) {
                log.error(`CtrlZTree: redo error: ${err?.message || 'Unknown'}`);
                vscode.window.showWarningMessage('CtrlZTree: Redo busy, try again.');
                return;
            }
            if (!navResult.hash || !navResult.content) {
                if (controller) {
                    const proj = controller.getProjection();
                    const recentErrors = proj.diagnostics.filter(
                        d => d.severity === 'error' && (d.eventSeq ?? 0) >= proj.lastSeq - 5
                    );
                    if (recentErrors.length > 0) {
                        log.error(`CtrlZTree: redo failed due to internal inconsistency: ${recentErrors.map(d => d.message).join('; ')}`);
                        vscode.window.showWarningMessage('CtrlZTree: Redo failed — internal state inconsistency detected. See output for details.');
                        return;
                    }
                }
                log.error('CtrlZTree: Redo returned no content.');
                return;
            }
            const result = await applyTreeStateToDocument(document, tree, 'redo', editTokens, controller);
            if (!result.ok) {
                if (savedHead) {
                    const failedHead = navResult.hash;
                    tree.setHead(savedHead);
                    controller.setHeadDirectly(savedHead);
                }
                return;
            }
            await markEditorCleanIfAtInitialSnapshot(tree, document);
            extensionState.pendingChanges.delete(document.uri.toString());
            historyTreeProvider.refresh();
            return;
        }

        // Multi-branch: user must choose
        const currentContent = tree.getContent();
        const items = children.map(hash => {
            const branchContent = tree.getContent(hash);
            const diffPreview = generateDiffSummary(currentContent, branchContent);
            return {
                label: `Branch ${hash.substring(0, 8)}`,
                description: diffPreview.replace(/\n/g, ' | '),
                hash
            };
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select branch to restore'
        });

        if (!selected) { return; }

        const savedHead = tree.getHead();
        let navResult: { hash: string | null; content: string | null };
        try {
            navResult = await controller.redo(selected.hash);
        } catch (err: any) {
            log.error(`CtrlZTree: redo error: ${err?.message || 'Unknown'}`);
            vscode.window.showWarningMessage('CtrlZTree: Redo busy, try again.');
            return;
        }
        if (!navResult.hash || !navResult.content) {
            log.error('CtrlZTree: Redo returned no content.');
            return;
        }
        const result = await applyTreeStateToDocument(document, tree, 'redo', editTokens, controller);
        if (!result.ok) {
            if (savedHead) {
                const failedHead = navResult.hash;
                tree.setHead(savedHead);
                controller.setHeadDirectly(savedHead);
            }
            return;
        }
        await markEditorCleanIfAtInitialSnapshot(tree, document);
        extensionState.pendingChanges.delete(document.uri.toString());
        historyTreeProvider.refresh();
    });

    // W8/W9: AI commands
    const setApiKeyCommand = vscode.commands.registerCommand('ctrlztree.ai.setApiKey', async () => {
        const config = vscode.workspace.getConfiguration('ctrlztree');
        const provider = config.get<string>('ai.provider', 'openai-chat-compatible') as ProviderName;

        const validProviders: ProviderName[] = ['openai-chat-compatible', 'openai-responses', 'anthropic-messages', 'custom-http-json'];
        if (!validProviders.includes(provider)) {
            vscode.window.showErrorMessage(`CtrlZTree: Invalid provider "${provider}". Check your ai.provider setting.`);
            return;
        }

        const key = await vscode.window.showInputBox({
            prompt: `Enter API key for provider: ${provider}`,
            password: true,
            placeHolder: 'sk-... or your API key',
            ignoreFocusOut: true,
        });

        if (!key || key.trim().length === 0) {
            return;
        }

        const storageKey = `ctrlztree.ai.key.${provider}`;
        await secretStore.set(storageKey, key.trim());
        log.info(`CtrlZTree: API key saved for provider ${provider}`);
        vscode.window.showInformationMessage(`CtrlZTree: API key saved for ${provider}`);
    });

    const clearApiKeyCommand = vscode.commands.registerCommand('ctrlztree.ai.clearApiKey', async () => {
        const config = vscode.workspace.getConfiguration('ctrlztree');
        const provider = config.get<string>('ai.provider', 'openai-chat-compatible') as ProviderName;

        const choice = await vscode.window.showWarningMessage(
            `Clear API key for provider: ${provider}?`,
            { modal: true },
            'Clear'
        );

        if (choice !== 'Clear') {
            return;
        }

        const storageKey = `ctrlztree.ai.key.${provider}`;
        await secretStore.delete(storageKey);
        log.info(`CtrlZTree: API key cleared for provider ${provider}`);
        vscode.window.showInformationMessage(`CtrlZTree: API key cleared for ${provider}`);
    });

    const testConnectionCommand = vscode.commands.registerCommand('ctrlztree.ai.testConnection', async () => {
        const rawConfig = vscode.workspace.getConfiguration('ctrlztree');
        const aiConfig = clampAiConfig({
            enabled: rawConfig.get<unknown>('ai.enabled') as boolean | undefined,
            provider: rawConfig.get<string>('ai.provider'),
            model: rawConfig.get<string>('ai.model'),
            baseUrl: rawConfig.get<string>('ai.baseUrl'),
        });

        if (!aiConfig.valid) {
            vscode.window.showErrorMessage(`CtrlZTree: Invalid AI configuration: ${aiConfig.errors.join('; ')}`);
            return;
        }

        vscode.window.showInformationMessage(`CtrlZTree: Testing connection to ${aiConfig.provider} (${aiConfig.model})...`);

        const result = await aiService.testConnection(aiConfig);

        if (result.ok) {
            log.info(`CtrlZTree: Test connection to ${aiConfig.provider} successful`);
            vscode.window.showInformationMessage(`CtrlZTree: Connection to ${aiConfig.provider} (${aiConfig.model}) successful ✓`);
        } else if (result.statusCode === 401 || result.statusCode === 403) {
            log.info(`CtrlZTree: Test connection auth failed (${result.statusCode})`);
            vscode.window.showErrorMessage(`CtrlZTree: Authentication failed (${result.statusCode}). Check your API key.`);
        } else {
            log.warn(`CtrlZTree: Test connection failed: ${result.error}`);
            vscode.window.showWarningMessage(`CtrlZTree: Connection test failed: ${result.error}`);
        }
    });

    // AI: Summarize current head node
    const summarizeCurrentNodeCommand = vscode.commands.registerCommand('ctrlztree.ai.summarizeCurrentNode', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isTrackableDocument(editor.document)) { return; }
        const rawConfig = vscode.workspace.getConfiguration('ctrlztree');
        const aiConfig = clampAiConfig({
            enabled: rawConfig.get<unknown>('ai.enabled') as boolean | undefined,
            provider: rawConfig.get<string>('ai.provider'),
            model: rawConfig.get<string>('ai.model'),
            baseUrl: rawConfig.get<string>('ai.baseUrl'),
        });
        if (!aiConfig.valid) {
            vscode.window.showErrorMessage(`CtrlZTree: Invalid AI configuration: ${aiConfig.errors.join('; ')}`);
            return;
        }
        const controller = await getOrCreateController(editor.document);
        const proj = controller.getProjection();
        const tree = controller.getTree();
        const headHash = tree.getHead();
        if (!headHash) { return; }
        const headNodeId = controller.getNodeIdByHash(headHash);
        if (headNodeId === undefined) { return; }
        const diffStr = tree.getAllNodes().get(headHash)?.diff ?? '';
        const filePath = editor.document.uri.fsPath;
        const ctx: PromptContext = {
            task: 'summarize_node',
            nodeId: headNodeId,
            diffSummary: diffStr,
            fileLanguage: editor.document.languageId,
            filePath,
            headNodeId,
            baseSeq: proj.lastSeq,
            docFingerprint: PersistenceService.computeFingerprint(editor.document.uri.toString()),
            projection: proj,
        };
        const request = buildUnifiedRequest(ctx, aiConfig.model);
        const response = await aiService.sendRequest(editor.document.uri.toString(), aiConfig, request);
        if ('ok' in response && response.ok === false) {
            vscode.window.showErrorMessage(`CtrlZTree: AI summarization failed: ${response.error}`);
            return;
        }
        const aiResp = response as import('./ai/types').UnifiedAiResponse;
        if (aiResp.nodeUpdates.length > 0) {
            controller.applyAiNodeUpdates(aiResp.nodeUpdates, { provider: aiConfig.provider, model: aiConfig.model });
            historyTreeProvider.refresh();
            vscode.window.showInformationMessage(`CtrlZTree: AI summary applied to head node.`);
        } else {
            vscode.window.showInformationMessage('CtrlZTree: AI returned no updates.');
        }
    });

    // AI: Rename selected node (context menu)
    const renameNodeCommand = vscode.commands.registerCommand('ctrlztree.ai.renameNode', async (item?: { nodeHash: string }) => {
        if (!item?.nodeHash) { return; }
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isTrackableDocument(editor.document)) { return; }
        const rawConfig = vscode.workspace.getConfiguration('ctrlztree');
        const aiConfig = clampAiConfig({
            enabled: rawConfig.get<unknown>('ai.enabled') as boolean | undefined,
            provider: rawConfig.get<string>('ai.provider'),
            model: rawConfig.get<string>('ai.model'),
            baseUrl: rawConfig.get<string>('ai.baseUrl'),
        });
        if (!aiConfig.valid) {
            vscode.window.showErrorMessage(`CtrlZTree: Invalid AI configuration: ${aiConfig.errors.join('; ')}`);
            return;
        }
        const controller = await getOrCreateController(editor.document);
        const proj = controller.getProjection();
        const tree = controller.getTree();
        const nodeId = controller.getNodeIdByHash(item.nodeHash);
        if (nodeId === undefined) { return; }
        const diffStr = tree.getAllNodes().get(item.nodeHash)?.diff ?? '';
        const ctx: PromptContext = {
            task: 'rename_node',
            nodeId,
            diffSummary: diffStr,
            fileLanguage: editor.document.languageId,
            filePath: editor.document.uri.fsPath,
            headNodeId: proj.headId,
            baseSeq: proj.lastSeq,
            docFingerprint: PersistenceService.computeFingerprint(editor.document.uri.toString()),
            projection: proj,
        };
        const request = buildUnifiedRequest(ctx, aiConfig.model);
        const response = await aiService.sendRequest(editor.document.uri.toString(), aiConfig, request);
        if ('ok' in response && response.ok === false) {
            vscode.window.showErrorMessage(`CtrlZTree: AI rename failed: ${response.error}`);
            return;
        }
        const aiResp = response as import('./ai/types').UnifiedAiResponse;
        if (aiResp.nodeUpdates.length > 0) {
            controller.applyAiNodeUpdates(aiResp.nodeUpdates, { provider: aiConfig.provider, model: aiConfig.model });
            historyTreeProvider.refresh();
        }
    });

    // AI: Summarize selected node (context menu)
    const summarizeNodeCommand = vscode.commands.registerCommand('ctrlztree.ai.summarizeNode', async (item?: { nodeHash: string }) => {
        if (!item?.nodeHash) { return; }
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isTrackableDocument(editor.document)) { return; }
        const rawConfig = vscode.workspace.getConfiguration('ctrlztree');
        const aiConfig = clampAiConfig({
            enabled: rawConfig.get<unknown>('ai.enabled') as boolean | undefined,
            provider: rawConfig.get<string>('ai.provider'),
            model: rawConfig.get<string>('ai.model'),
            baseUrl: rawConfig.get<string>('ai.baseUrl'),
        });
        if (!aiConfig.valid) {
            vscode.window.showErrorMessage(`CtrlZTree: Invalid AI configuration: ${aiConfig.errors.join('; ')}`);
            return;
        }
        const controller = await getOrCreateController(editor.document);
        const proj = controller.getProjection();
        const tree = controller.getTree();
        const nodeId = controller.getNodeIdByHash(item.nodeHash);
        if (nodeId === undefined) { return; }
        const diffStr = tree.getAllNodes().get(item.nodeHash)?.diff ?? '';
        const ctx: PromptContext = {
            task: 'summarize_node',
            nodeId,
            diffSummary: diffStr,
            fileLanguage: editor.document.languageId,
            filePath: editor.document.uri.fsPath,
            headNodeId: proj.headId,
            baseSeq: proj.lastSeq,
            docFingerprint: PersistenceService.computeFingerprint(editor.document.uri.toString()),
            projection: proj,
        };
        const request = buildUnifiedRequest(ctx, aiConfig.model);
        const response = await aiService.sendRequest(editor.document.uri.toString(), aiConfig, request);
        if ('ok' in response && response.ok === false) {
            vscode.window.showErrorMessage(`CtrlZTree: AI summarization failed: ${response.error}`);
            return;
        }
        const aiResp = response as import('./ai/types').UnifiedAiResponse;
        if (aiResp.nodeUpdates.length > 0) {
            controller.applyAiNodeUpdates(aiResp.nodeUpdates, { provider: aiConfig.provider, model: aiConfig.model });
            historyTreeProvider.refresh();
        }
    });

    // AI: Propose merge for current head path
    const proposeMergeCommand = vscode.commands.registerCommand('ctrlztree.ai.proposeMerge', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isTrackableDocument(editor.document)) { return; }
        const rawConfig = vscode.workspace.getConfiguration('ctrlztree');
        const aiConfig = clampAiConfig({
            enabled: rawConfig.get<unknown>('ai.enabled') as boolean | undefined,
            provider: rawConfig.get<string>('ai.provider'),
            model: rawConfig.get<string>('ai.model'),
            baseUrl: rawConfig.get<string>('ai.baseUrl'),
        });
        if (!aiConfig.valid) {
            vscode.window.showErrorMessage(`CtrlZTree: Invalid AI configuration: ${aiConfig.errors.join('; ')}`);
            return;
        }
        const controller = await getOrCreateController(editor.document);
        const proj = controller.getProjection();
        const tree = controller.getTree();

        // Find linear chain on head path
        const linearChain: number[] = [];
        let cursor: number | null = proj.headId;
        while (cursor !== null && cursor !== proj.rootId) {
            const children = proj.childrenOf.get(cursor) ?? [];
            if (children.filter(c => !proj.deletedNodes.has(c) && !proj.archivedNodes.has(c)).length <= 1) {
                linearChain.push(cursor);
            } else {
                break;
            }
            const parent: number | null = proj.parentOf.get(cursor) ?? null;
            cursor = parent;
        }
        if (linearChain.length < 2) {
            vscode.window.showInformationMessage('CtrlZTree: No linear chain found for merge analysis.');
            return;
        }

        // Build diff summaries for the chain
        const siblingSummaries: string[] = [];
        for (const nodeId of linearChain) {
            const hash = controller.getHashByNodeId(nodeId);
            const diffStr = hash ? (tree.getAllNodes().get(hash)?.diff ?? '') : '';
            siblingSummaries.push(diffStr);
        }

        const parentId = proj.parentOf.get(linearChain[linearChain.length - 1]);
        let parentDiffSummary = '';
        if (parentId !== undefined && parentId !== null) {
            const parentHash = controller.getHashByNodeId(parentId);
            parentDiffSummary = parentHash ? (tree.getAllNodes().get(parentHash)?.diff ?? '') : '';
        }

        const ctx: PromptContext = {
            task: 'propose_merge',
            nodeIds: linearChain,
            diffSummary: siblingSummaries.join('\n'),
            parentDiffSummary,
            siblingSummaries,
            fileLanguage: editor.document.languageId,
            filePath: editor.document.uri.fsPath,
            headNodeId: proj.headId,
            baseSeq: proj.lastSeq,
            docFingerprint: PersistenceService.computeFingerprint(editor.document.uri.toString()),
            projection: proj,
        };
        const request = buildUnifiedRequest(ctx, aiConfig.model);
        vscode.window.showInformationMessage('CtrlZTree: Analyzing merge candidates with AI...');
        const response = await aiService.sendRequest(editor.document.uri.toString(), aiConfig, request);
        if ('ok' in response && response.ok === false) {
            vscode.window.showErrorMessage(`CtrlZTree: AI merge proposal failed: ${response.error}`);
            return;
        }
        const aiResp = response as import('./ai/types').UnifiedAiResponse;
        const mergeOps = aiResp.operationPlan.filter(p => p.operation === 'merge');
        if (mergeOps.length === 0) {
            vscode.window.showInformationMessage('CtrlZTree: AI found no merge candidates.');
        } else {
            const details = mergeOps.map(p =>
                `Nodes ${p.targetIds.join(', ')}: ${p.reason} (risk: ${p.risk})`
            ).join('\n');
            const choice = await vscode.window.showInformationMessage(
                `AI merge suggestions:\n${details}\n\nExecute suggested merges?`,
                { modal: true },
                'Execute'
            );
            if (choice === 'Execute') {
                let merged = 0;
                for (const plan of mergeOps) {
                    if (plan.targetIds.length < 2) { continue; }
                    const mergePlan = generateMergePlan(proj, plan.targetIds);
                    if (!mergePlan.valid) { continue; }
                    const resultContent = controller.getContent();
                    const result = controller.executeMergePlan(mergePlan, resultContent);
                    if (result.ok) { merged++; }
                }
                if (merged > 0) {
                    historyTreeProvider.refresh();
                    vscode.window.showInformationMessage(`CtrlZTree: Executed ${merged} AI-suggested merge(s).`);
                }
            }
        }
    });

    context.subscriptions.push(undoCommand, redoCommand, mergeCommand, setApiKeyCommand, clearApiKeyCommand, testConnectionCommand,
        summarizeCurrentNodeCommand, renameNodeCommand, summarizeNodeCommand, proposeMergeCommand);

    log.info('CtrlZTree: Extension activation completed successfully.');
}

export async function deactivate() {
    // Clear persist timer
    if (extensionState.persistTimer) {
        clearInterval(extensionState.persistTimer);
        extensionState.persistTimer = null;
    }

    // Flush all controllers to disk before shutdown
    const controllers = Array.from(extensionState.historyControllers.values());
    const flushes: Promise<void>[] = [];
    for (const controller of controllers) {
        if (controller.getNeedsPersist()) {
            flushes.push(
                controller.flushToDisk()
                    .then(result => {
                        if (!result.ok) {
                            console.error(`CtrlZTree deactivate: flush failed: ${result.error}`);
                        }
                    })
                    .catch(err => {
                        console.error(`CtrlZTree deactivate: flush error: ${err?.message || 'Unknown'}`);
                    })
            );
        }
    }
    // Wait for all flushes with a hard timeout of 3 seconds
    if (flushes.length > 0) {
        const timeout = new Promise<void>(resolve => setTimeout(() => {
            console.warn('CtrlZTree deactivate: flush timeout reached, some data may not be persisted');
            resolve();
        }, 3000));
        await Promise.race([Promise.allSettled(flushes), timeout]);
    }
    extensionState.historyControllers.clear();

    for (const timeout of extensionState.documentChangeTimeouts.values()) {
        clearTimeout(timeout);
    }
    extensionState.documentChangeTimeouts.clear();
    extensionState.pendingChanges.clear();
    extensionState.lastChangeTime.clear();
    extensionState.lastCursorPosition.clear();
    extensionState.lastChangeType.clear();
    extensionState.processingDocuments.clear();
    if (extensionState.editTokens) {
        extensionState.editTokens.clear();
        extensionState.editTokens = null;
    }
}

async function applyTreeStateToDocument(
    document: vscode.TextDocument,
    tree: CtrlZTree,
    reason: ApplyEditToken['reason'],
    editTokens: ApplyEditTokenSet,
    controller?: HistoryController
): Promise<ApplyEditResult> {
    const docId = document.uri.toString();
    const token = editTokens.begin(docId, reason);
    try {
        // Prefer controller's content for consistent state (reduces dual-store divergence)
        const content = controller ? controller.getContent() : tree.getContent();
        // Use tree cursor since cursor position is stored per-node in the legacy tree
        const cursorPosition = tree.getCursorPosition();

        // Safety net: never overwrite non-empty document with empty content
        if (content.length === 0 && document.getText().length > 0) {
            return { ok: false, error: 'Refusing to overwrite non-empty document with empty content' };
        }

        const result = await applyEditAndVerify(document, content);

        if (!result.ok) {
            vscode.window.showErrorMessage(`CtrlZTree: Failed to apply edit: ${result.error}`);
            return result;
        }

        if (cursorPosition) {
            const maxLine = document.lineCount - 1;
            const adjustedLine = Math.min(cursorPosition.line, maxLine);
            const maxChar = document.lineAt(adjustedLine).text.length;
            const adjustedChar = Math.min(cursorPosition.character, maxChar);
            const adjustedPosition = new vscode.Position(adjustedLine, adjustedChar);
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.uri.toString() === document.uri.toString()) {
                editor.selection = new vscode.Selection(adjustedPosition, adjustedPosition);
                editor.revealRange(new vscode.Range(adjustedPosition, adjustedPosition));
            }
        }

        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`CtrlZTree: Failed to apply edit: ${message}`);
        return { ok: false, error: message };
    } finally {
        editTokens.end(token);
    }
}
