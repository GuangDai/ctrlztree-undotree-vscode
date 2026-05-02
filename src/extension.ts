import * as vscode from 'vscode';
import { generateDiffSummary } from './lcs';
import { CtrlZTree } from './model/ctrlZTree';
import { createExtensionState } from './state/extensionState';
import { DIFF_SCHEME, ACTION_TIMEOUT, PAUSE_THRESHOLD } from './constants';
import { createWebviewManager, WebviewManager } from './webview/webviewManager';
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

    // Dynamic log level change listener
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('ctrlztree.logging.level')) {
                const newLevel = vscode.workspace.getConfiguration('ctrlztree').get<string>('logging.level', 'info') as LogLevel;
                log.setLevel(newLevel);
                log.info(`CtrlZTree: Log level changed to ${newLevel}`);
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
    const persistenceService = new PersistenceService(secretStore, context);
    let persistenceActive = false;

    if (persistenceMode === 'off') {
        log.info('CtrlZTree: Persistence disabled (mode=off).');
    } else if (persistenceMode === 'on') {
        persistenceService.initialize().then(initResult => {
            if (initResult.ok) {
                persistenceActive = true;
                log.info('CtrlZTree: PersistenceService initialized (mode=on).');
            } else {
                log.warn(`CtrlZTree: PersistenceService not available: ${initResult.error}`);
            }
        });
    } else if (persistenceMode === 'ask') {
        persistenceService.initialize().then(initResult => {
            if (initResult.ok) {
                // Prompt user for consent before enabling persistence
                vscode.window.showInformationMessage(
                    'CtrlZTree can save your edit history to disk (encrypted). Enable history persistence?',
                    'Enable', 'Not Now'
                ).then(choice => {
                    if (choice === 'Enable') {
                        persistenceActive = true;
                        log.info('CtrlZTree: User enabled history persistence.');
                    } else {
                        log.info('CtrlZTree: User declined history persistence.');
                    }
                });
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

    const getOrCreateController = async (document: vscode.TextDocument): Promise<HistoryController> => {
        const key = document.uri.toString();
        let controller = extensionState.historyControllers.get(key);
        if (!controller) {
            const tree = getOrCreateTree(document);
            const contentStore = new MemoryContentStore();
            const deps = { docId: key, tree, queue: documentQueue, contentStore, persistenceService, logger: log };

            // Try to restore from persisted history if persistence is active
            if (persistenceActive) {
                const fp = PersistenceService.computeFingerprint(key);
                const loadResult = await persistenceService.loadDocument(fp);
                if (loadResult.ok && loadResult.events.length > 0) {
                    controller = await HistoryController.fromPersistedEvents(deps, loadResult.events, loadResult.contentEntries);
                    log.info(`CtrlZTree: Restored ${loadResult.events.length} events from disk for ${key}`);
                }
            }

            if (!controller) {
                controller = new HistoryController(deps);
                log.debug(`CtrlZTree: Created new HistoryController for ${key}`);
            }

            extensionState.historyControllers.set(key, controller);
        }
        return controller;
    };

    async function navigateToNode(docUri: string, hash: string): Promise<{ ok: boolean }> {
        const controller = extensionState.historyControllers.get(docUri);
        if (!controller) {
            // Fallback: no controller, use tree directly
            const tree = extensionState.historyTrees.get(docUri);
            if (!tree) { return { ok: false }; }
            const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === docUri);
            if (!doc) { return { ok: false }; }
            const savedHead = tree.getHead();
            if (!tree.setHead(hash)) { return { ok: false }; }
            const token = editTokens.begin(docUri, 'navigate');
            try {
                const content = tree.getContent();
                const result = await applyEditAndVerify(doc, content);
                if (!result.ok && savedHead) { tree.setHead(savedHead); }
                return { ok: result.ok };
            } finally {
                editTokens.end(token);
            }
        }
        const result = await controller.checkout(hash);
        return { ok: result.success };
    }

    const webviewManager = createWebviewManager({
        context,
        outputChannel,
        state: extensionState,
        getOrCreateTree,
        editTokens,
        diffContentRegistry,
        onHistoryReset: (docUri: string) => {
            const ctrl = extensionState.historyControllers.get(docUri);
            if (ctrl) {
                ctrl.close().catch(() => { /* best effort */ });
                extensionState.historyControllers.delete(docUri);
                log.info(`CtrlZTree: Closed controller for reset doc ${docUri}`);
            }
        },
        navigateToNode,
    });

    // W5: TreeView provider (created early so changeTracker can refresh it)
    const historyTreeProvider = new HistoryTreeProvider();
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('ctrlztree.history', historyTreeProvider)
    );

    const changeTracker = registerDocumentChangeTracking({
        context,
        outputChannel,
        state: extensionState,
        getOrCreateTree,
        getOrCreateController,
        webviewManager,
        editTokens,
        setLastValidEditorUri: uri => {
            extensionState.lastValidEditorUri = uri;
        },
        actionTimeout: ACTION_TIMEOUT,
        pauseThreshold: PAUSE_THRESHOLD,
        onDocumentCommitted: (docUri, tree) => {
            historyTreeProvider.setTree(tree, docUri);
        }
    });
    context.subscriptions.push(changeTracker);

    const themeChangeSubscription = vscode.window.onDidChangeActiveColorTheme(() => {
        log.debug('CtrlZTree: Color theme changed.');
        webviewManager.broadcastThemeRefresh();
    });

    const activeEditorChangeSubscription = vscode.window.onDidChangeActiveTextEditor(editor => {
        void webviewManager.handleActiveEditorChange(editor);
        // Also update TreeView
        if (editor && isTrackableDocument(editor.document)) {
            const tree = getOrCreateTree(editor.document);
            historyTreeProvider.setTree(tree, editor.document.uri.toString());
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
    });

    // Listen for new files opening to track them immediately
    const documentOpenSubscription = vscode.workspace.onDidOpenTextDocument(document => {
        if (isTrackableDocument(document)) {
            getOrCreateTree(document);
        }
    });

    // W6: Auto-persist timer (flushes dirty controllers to disk every 5 seconds)
    // Only active when persistence is enabled (mode=on or user approved ask)
    let persistFlushInProgress = false;
    const persistTimer = setInterval(() => {
        if (!persistenceActive || persistFlushInProgress) { return; }
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
    extensionState.persistTimer = persistTimer;
    // Ensure timer is cleaned up even on abnormal deactivation
    context.subscriptions.push({ dispose: () => {
        clearInterval(persistTimer);
        extensionState.persistTimer = null;
    }});

    context.subscriptions.push(themeChangeSubscription, activeEditorChangeSubscription, documentCloseSubscription, documentOpenSubscription);

    // Eagerly initialize trees for documents already open on startup
    vscode.workspace.textDocuments.forEach(document => {
        if (isTrackableDocument(document)) {
            getOrCreateTree(document);
        }
    });

    // Handle the currently active editor on startup
    if (vscode.window.activeTextEditor) {
        void webviewManager.handleActiveEditorChange(vscode.window.activeTextEditor);
    }

    // Initialize TreeView for current editor
    if (vscode.window.activeTextEditor && isTrackableDocument(vscode.window.activeTextEditor.document)) {
        const tree = getOrCreateTree(vscode.window.activeTextEditor.document);
        historyTreeProvider.setTree(tree, vscode.window.activeTextEditor.document.uri.toString());
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
                const tree = getOrCreateTree(editor.document);
                historyTreeProvider.setTree(tree, editor.document.uri.toString());
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
                    applyTreeStateToDocument(document, tree, 'checkout', editTokens, controller).catch(() => {});
                }
                log.error(`CtrlZTree: TreeView navigate apply failed: ${applyResult.error}`);
            }
            historyTreeProvider.refresh();
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
            if (!node || !node.parent) {return;}

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

            vscode.window.showInformationMessage(
                `CtrlZTree: Merged ${linearChain.length} nodes into node #${result.nodeId}. Write your next edit to see the result.`
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
        const navResult = await controller.undo();
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
                const failedHead = navResult.hash; // head was moved here by controller.undo()
                tree.setHead(savedHead);
                // Record rollback: from failed position back to saved position
                controller.recordHeadMove(failedHead, savedHead, 'undo');
            }
            return;
        }

        await markEditorCleanIfAtInitialSnapshot(tree, document, { outputChannel });
        updatePanelForDocument(tree, document.uri.toString(), webviewManager);
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
            const navResult = await controller.redo(children[0]);
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
                    controller.recordHeadMove(failedHead, savedHead, 'redo');
                }
                return;
            }
            await markEditorCleanIfAtInitialSnapshot(tree, document);
            updatePanelForDocument(tree, document.uri.toString(), webviewManager);
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
        const navResult = await controller.redo(selected.hash);
        if (!navResult.hash || !navResult.content) {
            log.error('CtrlZTree: Redo returned no content.');
            return;
        }
        const result = await applyTreeStateToDocument(document, tree, 'redo', editTokens, controller);
        if (!result.ok) {
            if (savedHead) {
                const failedHead = navResult.hash;
                tree.setHead(savedHead);
                controller.recordHeadMove(failedHead, savedHead, 'redo');
            }
            return;
        }
        await markEditorCleanIfAtInitialSnapshot(tree, document);
        updatePanelForDocument(tree, document.uri.toString(), webviewManager);
    });

    async function resolveDocumentForVisualization(preferredDocument?: vscode.TextDocument): Promise<vscode.TextDocument | undefined> {
        if (isTrackableDocument(preferredDocument)) {
            return preferredDocument;
        }

        const activeDoc = vscode.window.activeTextEditor?.document;
        if (isTrackableDocument(activeDoc)) {
            return activeDoc;
        }

        const visibleEditor = vscode.window.visibleTextEditors.find(editor => isTrackableDocument(editor.document));
        if (visibleEditor) {
            return visibleEditor.document;
        }

        if (extensionState.lastValidEditorUri) {
            const matchingDoc = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === extensionState.lastValidEditorUri);
            if (isTrackableDocument(matchingDoc)) {
                return matchingDoc;
            }

            try {
                const reopened = await vscode.workspace.openTextDocument(vscode.Uri.parse(extensionState.lastValidEditorUri));
                if (isTrackableDocument(reopened)) {
                    return reopened;
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log.warn(`CtrlZTree: Could not reopen last edited document ${extensionState.lastValidEditorUri}: ${message}`);
            }
        }

        const workspaceDoc = vscode.workspace.textDocuments.find(isTrackableDocument);
        if (workspaceDoc) {
            return workspaceDoc;
        }

        return waitForNextTrackableEditor(2000);
    }

    function waitForNextTrackableEditor(timeoutMs: number): Promise<vscode.TextDocument | undefined> {
        return new Promise(resolve => {
            let settled = false;
            let timer: NodeJS.Timeout | undefined;

            const disposable = vscode.window.onDidChangeActiveTextEditor(editor => {
                if (isTrackableDocument(editor?.document) && !settled) {
                    settled = true;
                    if (timer) {
                        clearTimeout(timer);
                    }
                    disposable.dispose();
                    resolve(editor!.document);
                }
            });

            timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    disposable.dispose();
                    resolve(undefined);
                }
            }, timeoutMs);
        });
    }

    const visualizeCommand = vscode.commands.registerCommand('ctrlztree.visualize', async (uri?: vscode.Uri) => {
        let preferredDocument: vscode.TextDocument | undefined;

        if (uri) {
            try {
                preferredDocument = await vscode.workspace.openTextDocument(uri);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log.error(`CtrlZTree: Failed to open provided document for visualize command: ${message}`);
            }
        }

        const targetDocument = await resolveDocumentForVisualization(preferredDocument);
        if (!targetDocument) {
            vscode.window.showInformationMessage('CtrlZTree: No active text document available to visualize yet.');
            return;
        }

        await webviewManager.showVisualizationForDocument(targetDocument);
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

    context.subscriptions.push(undoCommand, redoCommand, visualizeCommand, mergeCommand, setApiKeyCommand, clearApiKeyCommand, testConnectionCommand);

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
                    .then(() => {})
                    .catch(() => {}) // Best-effort flush on deactivate
            );
        }
    }
    // Wait for all flushes with a hard timeout of 3 seconds
    if (flushes.length > 0) {
        const timeout = new Promise<void>(resolve => setTimeout(resolve, 3000));
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
        const cursorPosition = tree.getCursorPosition();

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

function updatePanelForDocument(
    tree: CtrlZTree,
    docUriString: string,
    webviewManager: WebviewManager
) {
    const panel = extensionState.activeVisualizationPanels.get(docUriString);
    if (panel) {
        webviewManager.postUpdatesToWebview(panel, tree, docUriString);
    }
}