/**
 * CtrlZTree VS Code Extension — entry point.
 *
 * WHAT IT DOES:
 *   Assembles all subsystems in the correct initialization order during activate().
 *   Owns the ExtensionState singleton, the configuration change listener,
 *   the diff content provider, and the change tracking registration.
 *   Delegates command registration, persistence lifecycle, and controller management
 *   to specialized modules under src/commands/ and src/services/.
 *
 * ARCHITECTURAL ROLE:
 *   Integration surface. The only file that imports from every layer.
 *   Does NOT contain business logic — that lives in src/history/, src/ai/, src/model/.
 */

import * as vscode from 'vscode';
import { createExtensionState } from './state/extensionState';
import { DIFF_SCHEME, ACTION_TIMEOUT, PAUSE_THRESHOLD } from './constants';
import { registerDocumentChangeTracking } from './services/changeTracker';
import { createDiffContentRegistry } from './ui/diffContentRegistry';
import { clampConfig } from './config/configService';
import { ApplyEditTokenSet } from './concurrency/applyEditTokens';
import { HistoryTreeProvider } from './ui/historyTreeProvider';
import { createVSCodeSecretStore } from './security/secretStore';
import { ProviderRegistry, createDefaultCapabilities } from './ai/providers/registry';
import { buildOpenAIChatCompatibleRequest, parseOpenAIChatCompatibleResponse } from './ai/providers/openaiChatCompatibleProvider';
import { buildAnthropicMessagesRequest, parseAnthropicMessagesResponse } from './ai/providers/anthropicMessagesProvider';
import { buildOpenAIResponsesRequest, parseOpenAIResponsesResponse } from './ai/providers/openaiResponsesProvider';
import { buildCustomHttpJsonRequest, parseCustomHttpJsonResponse } from './ai/providers/customHttpJsonProvider';
import { DocumentTaskQueue } from './concurrency/documentTaskQueue';
import { BaseAiProvider } from './ai/providers/base';
import { AiService } from './ai/aiService';
import { RequestScheduler } from './concurrency/requestScheduler';
import { Logger, LogLevel } from './utils/logger';
import { isTrackableDocument } from './utils/extensionUtils';
import { setupPersistence, createPersistTimer, createPersistenceModeChangeHandler } from './services/persistenceLifecycle';
import { createGetOrCreateTree, createGetOrCreateController, createDocumentCloseHandler } from './services/controllerManager';
import { registerTreeAndNavigationCommands } from './commands/treeAndNavigationCommands';
import { registerMergeCommand } from './commands/mergeCommand';
import { registerAiCommands } from './commands/aiCommands';

const extensionState = createExtensionState();

export function activate(context: vscode.ExtensionContext) {
    // ---- 1. Logging ----
    const outputChannel = vscode.window.createOutputChannel('CtrlZTree');
    context.subscriptions.push(outputChannel);
    const log = new Logger(outputChannel);
    const logLevel = vscode.workspace.getConfiguration('ctrlztree').get<string>('logging.level', 'info') as LogLevel;
    log.setLevel(logLevel);
    log.info('CtrlZTree: Extension activating...');

    // ---- 2. Config change listener (let-bound for historyTreeProvider) ----
    let historyTreeProvider: HistoryTreeProvider;
    let handlePersistenceModeChange: (newMode: 'off' | 'ask' | 'on') => Promise<void>;
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('ctrlztree.logging.level')) {
                const newLevel = vscode.workspace.getConfiguration('ctrlztree').get<string>('logging.level', 'info') as LogLevel;
                log.setLevel(newLevel);
                log.info(`CtrlZTree: Log level changed to ${newLevel}`);
            }
            if (e.affectsConfiguration('ctrlztree.persistence.mode')) {
                const newMode = vscode.workspace.getConfiguration('ctrlztree').get<string>('persistence.mode', 'off') as 'off' | 'ask' | 'on';
                handlePersistenceModeChange?.(newMode).catch(err =>
                    log.error(`CtrlZTree: Persistence mode change error: ${err?.message || 'Unknown'}`)
                );
            }
            if (e.affectsConfiguration('ctrlztree.treeView')) {
                historyTreeProvider?.refresh();
            }
        })
    );

    // ---- 3. Core primitives ----
    const editTokens = new ApplyEditTokenSet();
    extensionState.editTokens = editTokens;
    const secretStore = createVSCodeSecretStore(context.secrets);

    // ---- 4. Persistence lifecycle ----
    const { persistenceService, persistenceReady } = setupPersistence(secretStore, context, extensionState, log);
    const persistTimer = createPersistTimer(extensionState, log);
    if (extensionState.persistenceMode !== 'off') {
        persistTimer.start();
    }
    context.subscriptions.push({ dispose: () => persistTimer.dispose() });
    handlePersistenceModeChange = createPersistenceModeChangeHandler(
        extensionState, persistenceService, () => persistTimer.start(), log
    );

    // ---- 5. Diff content provider ----
    const diffContentRegistry = createDiffContentRegistry();
    const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
        private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
        readonly onDidChange = this._onDidChange.event;
        provideTextDocumentContent(uri: vscode.Uri): string {
            const parts = uri.path.split('/').filter(p => p.length > 0);
            if (parts.length !== 2) { return ''; }
            const [registryId, side] = parts as [string, string];
            if (side !== 'original' && side !== 'modified') { return ''; }
            if (!registryId) { return ''; }
            const record = diffContentRegistry.get(registryId);
            if (!record) { return ''; }
            return side === 'original' ? record.original : record.modified;
        }
    })();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffContentProvider)
    );

    // ---- 6. Factory functions ----
    const getConfig = () => {
        const config = vscode.workspace.getConfiguration('ctrlztree');
        return clampConfig({
            enablePruning: config.get<unknown>('enablePruning') as boolean | undefined,
            maxHistoryNodesPerDocument: config.get<unknown>('maxHistoryNodesPerDocument') as number | undefined,
            maxTrackedDocuments: config.get<unknown>('maxTrackedDocuments') as number | undefined,
        }, (msg: string) => log.warn(msg));
    };
    const documentQueue = new DocumentTaskQueue();
    const getOrCreateTree = createGetOrCreateTree(extensionState, getConfig, log);
    const getOrCreateController = createGetOrCreateController(
        extensionState, getOrCreateTree, persistenceService, persistenceReady, documentQueue, log
    );
    const handleDocumentClose = createDocumentCloseHandler(extensionState, editTokens, log);

    // ---- 7. Tree view ----
    historyTreeProvider = new HistoryTreeProvider();
    const historyTreeView = vscode.window.createTreeView('ctrlztree.history', {
        treeDataProvider: historyTreeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(historyTreeView);
    historyTreeView.onDidChangeSelection(e => {
        if (e.selection.length === 1) {
            const item = e.selection[0];
            vscode.commands.executeCommand('ctrlztree.history.diffWithCurrent', item);
        }
    });

    // ---- 8. Change tracking ----
    const changeTracker = registerDocumentChangeTracking({
        context,
        outputChannel,
        state: extensionState,
        getOrCreateTree,
        getOrCreateController,
        editTokens,
        setLastValidEditorUri: uri => { extensionState.lastValidEditorUri = uri; },
        actionTimeout: ACTION_TIMEOUT,
        pauseThreshold: PAUSE_THRESHOLD,
        onDocumentCommitted: (docUri) => {
            const controller = extensionState.historyControllers.get(docUri);
            historyTreeProvider.setController(controller ?? null, docUri);
        }
    });
    context.subscriptions.push(changeTracker);

    // ---- 9. Editor subscriptions ----
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && isTrackableDocument(editor.document)) {
                const controller = extensionState.historyControllers.get(editor.document.uri.toString());
                historyTreeProvider.setController(controller ?? null, editor.document.uri.toString());
            } else {
                historyTreeProvider.clear();
            }
        }),
        vscode.workspace.onDidCloseTextDocument(async document => {
            await handleDocumentClose(document.uri.toString());
        }),
        vscode.workspace.onDidOpenTextDocument(document => {
            if (isTrackableDocument(document)) {
                getOrCreateTree(document);
            }
        })
    );

    // ---- 10. Startup: init open docs, set initial tree view ----
    vscode.workspace.textDocuments.forEach(document => {
        if (isTrackableDocument(document)) {
            getOrCreateTree(document);
        }
    });
    if (vscode.window.activeTextEditor && isTrackableDocument(vscode.window.activeTextEditor.document)) {
        const startupKey = vscode.window.activeTextEditor.document.uri.toString();
        const startupCtrl = extensionState.historyControllers.get(startupKey);
        historyTreeProvider.setController(startupCtrl ?? null, startupKey);
    }

    // ---- 11. AI pipeline ----
    const aiRegistry = new ProviderRegistry();
    const baseUrl = vscode.workspace.getConfiguration('ctrlztree').get<string>('ai.baseUrl', '');
    aiRegistry.register('openai-chat-compatible', new BaseAiProvider('openai-chat-compatible', createDefaultCapabilities('openai-chat-compatible'), baseUrl, buildOpenAIChatCompatibleRequest, parseOpenAIChatCompatibleResponse));
    aiRegistry.register('anthropic-messages', new BaseAiProvider('anthropic-messages', createDefaultCapabilities('anthropic-messages'), baseUrl, buildAnthropicMessagesRequest, parseAnthropicMessagesResponse));
    aiRegistry.register('openai-responses', new BaseAiProvider('openai-responses', createDefaultCapabilities('openai-responses'), baseUrl, buildOpenAIResponsesRequest, parseOpenAIResponsesResponse));
    aiRegistry.register('custom-http-json', new BaseAiProvider('custom-http-json', createDefaultCapabilities('custom-http-json'), baseUrl, buildCustomHttpJsonRequest, parseCustomHttpJsonResponse));
    const aiScheduler = new RequestScheduler();
    const aiService = new AiService({ registry: aiRegistry, scheduler: aiScheduler, secretStore, logger: log });

    // ---- 12. Command registrations ----
    registerTreeAndNavigationCommands(context, {
        extensionState, historyTreeProvider, getOrCreateTree, getOrCreateController,
        diffContentRegistry, editTokens, log, outputChannel
    });
    registerMergeCommand(context, { historyTreeProvider, getOrCreateController, log });
    registerAiCommands(context, { secretStore, aiService, historyTreeProvider, getOrCreateController, log });

    log.info('CtrlZTree: Extension activation completed successfully.');
}

export async function deactivate() {
    if (extensionState.persistTimer) {
        clearInterval(extensionState.persistTimer);
        extensionState.persistTimer = null;
    }

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
