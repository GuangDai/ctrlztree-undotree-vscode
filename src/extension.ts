import * as vscode from 'vscode';
import { generateDiffSummary } from './lcs';
import { CtrlZTree } from './model/ctrlZTree';
import { createExtensionState } from './state/extensionState';
import { DIFF_SCHEME, ACTION_TIMEOUT, PAUSE_THRESHOLD } from './constants';
import { createWebviewManager, WebviewManager } from './webview/webviewManager';
import { registerDocumentChangeTracking } from './services/changeTracker';
import { markEditorCleanIfAtInitialSnapshot } from './utils/editorState';
import { createDiffContentRegistry, DiffContentRegistry } from './ui/diffContentRegistry';
import { clampConfig } from './config/configService';
import { ApplyEditTokenSet, ApplyEditToken } from './concurrency/applyEditTokens';
import { applyEditAndVerify, ApplyEditResult } from './utils/editorApply';
import { HistoryTreeProvider } from './ui/historyTreeProvider';
import { createVSCodeSecretStore } from './security/secretStore';
import { ProviderRegistry } from './ai/providers/registry';
import { buildOpenAIChatCompatibleRequest } from './ai/providers/openaiChatCompatibleProvider';
import { buildAnthropicMessagesRequest } from './ai/providers/anthropicMessagesProvider';
import { buildOpenAIResponsesRequest } from './ai/providers/openaiResponsesProvider';
import { buildCustomHttpJsonRequest } from './ai/providers/customHttpJsonProvider';
import { ProviderName } from './ai/providers/registry';
import { redactSensitiveData } from './ai/redactor';
import { DocumentTaskQueue } from './concurrency/documentTaskQueue';
import { HistoryController } from './history/historyController';

const extensionState = createExtensionState();

// Helper moved to top-level so it's available to commands and initialization
function isTrackableDocument(document: vscode.TextDocument | undefined): document is vscode.TextDocument {
    return !!document && (document.uri.scheme === 'file' || document.uri.scheme === 'untitled');
}

function isValidUrl(str: string): boolean {
    try {
        const url = new URL(str);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('CtrlZTree');
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine('CtrlZTree: Extension activating...');

    const editTokens = new ApplyEditTokenSet();
    extensionState.editTokens = editTokens;

    const diffContentRegistry = createDiffContentRegistry();

    const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
        private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
        readonly onDidChange = this._onDidChange.event;

        provideTextDocumentContent(uri: vscode.Uri): string {
            const registryId = uri.authority;
            const side = uri.path.slice(1) as 'original' | 'modified';
            if (!registryId || (side !== 'original' && side !== 'modified')) {
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
        }, (msg: string) => outputChannel.appendLine(msg));
    };

    const getOrCreateTree = (document: vscode.TextDocument): CtrlZTree => {
        const key = document.uri.toString();
        let tree = extensionState.historyTrees.get(key);
        if (!tree) {
            tree = new CtrlZTree(document.getText());
            extensionState.historyTrees.set(key, tree);
            outputChannel.appendLine(`CtrlZTree: Created new tree for ${key}`);
        }

        const config = getConfig();

        // W4 TODO: Replace legacy pruneToMaxNodes with PruningEngine plan + archive.
        // Hard-deleting nodes from the legacy tree risks losing redo branches.
        // Temporarily disabled until W4 PruningEngine is wired into runtime.
        if (config.enablePruning && tree.getNodeCount() > config.maxHistoryNodesPerDocument) {
            outputChannel.appendLine(`CtrlZTree: History for ${key} exceeds maxNodes (${tree.getNodeCount()} > ${config.maxHistoryNodesPerDocument}). Pruning not yet wired - nodes retained.`);
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
                    const nodesA = treeA.getAllNodes();
                    const nodesB = treeB.getAllNodes();
                    const timeA = Math.max(...Array.from(nodesA.values()).map(n => n.timestamp));
                    const timeB = Math.max(...Array.from(nodesB.values()).map(n => n.timestamp));
                    return timeA - timeB; // Oldest first
                })
                .slice(0, extensionState.historyTrees.size - config.maxTrackedDocuments);

            for (const [uriToDelete] of entriesToDelete) {
                extensionState.historyTrees.delete(uriToDelete);
                outputChannel.appendLine(`CtrlZTree: Removed history for old document ${uriToDelete}`);
            }
        }

        return tree;
    };

    const documentQueue = new DocumentTaskQueue();

    const getOrCreateController = (document: vscode.TextDocument): HistoryController => {
        const key = document.uri.toString();
        let controller = extensionState.historyControllers.get(key);
        if (!controller) {
            const tree = getOrCreateTree(document);
            controller = new HistoryController({ docId: key, tree, queue: documentQueue });
            extensionState.historyControllers.set(key, controller);
            outputChannel.appendLine(`CtrlZTree: Created HistoryController for ${key}`);
        }
        return controller;
    };

    const webviewManager = createWebviewManager({
        context,
        outputChannel,
        state: extensionState,
        getOrCreateTree,
        editTokens,
        diffContentRegistry
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
        outputChannel.appendLine('CtrlZTree: Color theme changed, broadcasting refresh.');
        webviewManager.broadcastThemeRefresh();
    });

    const activeEditorChangeSubscription = vscode.window.onDidChangeActiveTextEditor(editor => {
        void webviewManager.handleActiveEditorChange(editor);
    });

    const documentCloseSubscription = vscode.workspace.onDidCloseTextDocument(document => {
        const key = document.uri.toString();
        const tree = extensionState.historyTrees.get(key);
        if (tree) {
            outputChannel.appendLine(`CtrlZTree: Cleaning up history for closed document ${key} (${tree.getNodeCount()} nodes)`);
            extensionState.historyTrees.delete(key);
        }

        const controller = extensionState.historyControllers.get(key);
        if (controller) {
            controller.close();
            extensionState.historyControllers.delete(key);
            outputChannel.appendLine(`CtrlZTree: Closed HistoryController for ${key}`);
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

    // Update TreeView when active editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && isTrackableDocument(editor.document)) {
                const tree = getOrCreateTree(editor.document);
                historyTreeProvider.setTree(tree, editor.document.uri.toString());
            } else {
                historyTreeProvider.clear();
            }
        })
    );

    // Initialize TreeView for current editor
    if (vscode.window.activeTextEditor && isTrackableDocument(vscode.window.activeTextEditor.document)) {
        const tree = getOrCreateTree(vscode.window.activeTextEditor.document);
        historyTreeProvider.setTree(tree, vscode.window.activeTextEditor.document.uri.toString());
    }

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
            const savedHead = tree.getHead();
            if (!tree.setHead(item.nodeHash)) {return;}

            const result = await applyTreeStateToDocument(document, tree, 'checkout', editTokens);
            if (result.ok) {
                const controller = getOrCreateController(document);
                controller.recordHeadMove(savedHead ?? '', item.nodeHash, 'checkout');
            }
            if (!result.ok && savedHead) {
                tree.setHead(savedHead);
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
            if (!node || !node.parent) {return;}

            const parentContent = tree.getContent(node.parent);
            const currentContent = tree.getContent(item.nodeHash);
            const parentShortHash = node.parent.substring(0, 8);
            const shortHash = item.nodeHash.substring(0, 8);
            const fileName = document.uri.path.split(/[\\/]/).pop() || 'document';

            const diffId = diffContentRegistry.register(parentContent, currentContent, fileName);
            const parentUri = vscode.Uri.parse(`${DIFF_SCHEME}:${diffId}/original`);
            const currentUri = vscode.Uri.parse(`${DIFF_SCHEME}:${diffId}/modified`);

            await vscode.commands.executeCommand('vscode.diff', parentUri, currentUri, `${fileName}: ${parentShortHash} ↔ ${shortHash}`, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        })
    );

    const undoCommand = vscode.commands.registerCommand('ctrlztree.undo', async () => {
        const editor = vscode.window.activeTextEditor;
        
        if (!editor || !isTrackableDocument(editor.document)) {
            await vscode.commands.executeCommand('undo');
            return;
        }

        const document = editor.document;
        const tree = getOrCreateTree(document);
        const previousHead = tree.getHead();
        const newHead = tree.peekUndo();

        if (!newHead) {
            outputChannel.appendLine('CtrlZTree: No more undo history.');
            vscode.window.showInformationMessage('CtrlZTree: No more undo history.');
            return;
        }

        outputChannel.appendLine(`CtrlZTree: Undo peek from ${previousHead} to ${newHead}`);

        // Save current head, temporarily set to target for content resolution
        const savedHead = tree.getHead();
        tree.setHead(newHead);
        const result = await applyTreeStateToDocument(document, tree, 'undo', editTokens);

        if (result.ok) {
            await markEditorCleanIfAtInitialSnapshot(tree, document, { outputChannel });
            updatePanelForDocument(tree, document.uri.toString(), webviewManager);
            const controller = getOrCreateController(document);
            controller.recordHeadMove(savedHead ?? '', tree.getHead()!, 'undo');
        } else {
            // Rollback head on failure
            if (savedHead) {
                tree.setHead(savedHead);
            }
        }
    });

    const redoCommand = vscode.commands.registerCommand('ctrlztree.redo', async () => {
        const editor = vscode.window.activeTextEditor;
        
        // Pass through to native redo if no editor or untrackable document
        if (!editor || !isTrackableDocument(editor.document)) {
            await vscode.commands.executeCommand('redo');
            return;
        }

        const document = editor.document;
        const tree = getOrCreateTree(document);
        const children = tree.peekRedoChildren();

        if (children.length === 0) {
            outputChannel.appendLine('CtrlZTree: No more redo history.');
            vscode.window.showInformationMessage('CtrlZTree: No more redo history.');
            return;
        }

        if (children.length === 1) {
            const savedHead = tree.getHead();
            const result = await applyRedoBranch(tree, children[0], document, webviewManager, editTokens);
            if (result.ok) {
                const controller = getOrCreateController(document);
                controller.recordHeadMove(savedHead ?? '', children[0], 'redo');
            }
            if (!result.ok) {
                outputChannel.appendLine(`CtrlZTree: Redo apply failed: ${result.error}`);
            }
            return;
        }

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

        if (!selected) {
            return;
        }

        const savedHead = tree.getHead();
        const result = await applyRedoBranch(tree, selected.hash, document, webviewManager, editTokens);
        if (result.ok) {
            const controller = getOrCreateController(document);
            controller.recordHeadMove(savedHead ?? '', selected.hash, 'redo');
        }
        if (!result.ok) {
            outputChannel.appendLine(`CtrlZTree: Redo apply failed: ${result.error}`);
        }
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
                outputChannel.appendLine(`CtrlZTree: Could not reopen last edited document ${extensionState.lastValidEditorUri}: ${message}`);
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
                outputChannel.appendLine(`CtrlZTree: Failed to open provided document for visualize command: ${message}`);
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
    const secretStore = createVSCodeSecretStore(context.secrets);

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
        outputChannel.appendLine(`CtrlZTree: API key saved for provider ${provider}`);
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
        outputChannel.appendLine(`CtrlZTree: API key cleared for provider ${provider}`);
        vscode.window.showInformationMessage(`CtrlZTree: API key cleared for ${provider}`);
    });

    const testConnectionCommand = vscode.commands.registerCommand('ctrlztree.ai.testConnection', async () => {
        const config = vscode.workspace.getConfiguration('ctrlztree');
        const provider = config.get<string>('ai.provider', 'openai-chat-compatible') as ProviderName;
        const baseUrl = config.get<string>('ai.baseUrl', '');
        const model = config.get<string>('ai.model', '');

        const validProviders: ProviderName[] = ['openai-chat-compatible', 'openai-responses', 'anthropic-messages', 'custom-http-json'];
        if (!validProviders.includes(provider)) {
            vscode.window.showErrorMessage(`CtrlZTree: Invalid provider "${provider}". Must be one of: ${validProviders.join(', ')}`);
            return;
        }

        if (!baseUrl || !model) {
            vscode.window.showErrorMessage('CtrlZTree: Please configure ai.baseUrl and ai.model in settings first.');
            return;
        }

        // Basic URL format validation
        if (!isValidUrl(baseUrl)) {
            vscode.window.showErrorMessage(`CtrlZTree: Invalid ai.baseUrl format: "${baseUrl}". Must be a valid URL.`);
            return;
        }

        const storageKey = `ctrlztree.ai.key.${provider}`;
        const apiKey = await secretStore.get(storageKey);
        if (!apiKey) {
            vscode.window.showErrorMessage(`CtrlZTree: No API key found for ${provider}. Run "CtrlZTree: Set AI API Key" first.`);
            return;
        }

        vscode.window.showInformationMessage(`CtrlZTree: Testing connection to ${provider} (${model})...`);

        const buildRequest = (url: string, key: string) => {
            switch (provider) {
                case 'openai-chat-compatible':
                    return buildOpenAIChatCompatibleRequest(
                        { task: 'summarize_node', model, system: '', messages: [{ role: 'user', content: 'Hi' }], responseSchema: { type: 'object', properties: {} }, maxOutputTokens: 16, temperature: 0, topP: 1, toolMode: 'none', parallelToolCalls: false, metadata: { promptVersion: 'test', docFingerprint: 'test', headNodeId: 0, baseSeq: 0 } },
                        key, url
                    );
                case 'anthropic-messages':
                    return buildAnthropicMessagesRequest(
                        { task: 'summarize_node', model, system: '', messages: [{ role: 'user', content: 'Hi' }], responseSchema: { type: 'object', properties: {} }, maxOutputTokens: 16, temperature: 0, topP: 1, toolMode: 'none', parallelToolCalls: false, metadata: { promptVersion: 'test', docFingerprint: 'test', headNodeId: 0, baseSeq: 0 } },
                        key, url
                    );
                case 'openai-responses':
                    return buildOpenAIResponsesRequest(
                        { task: 'summarize_node', model, system: '', messages: [{ role: 'user', content: 'Hi' }], responseSchema: { type: 'object', properties: {} }, maxOutputTokens: 16, temperature: 0, topP: 1, toolMode: 'none', parallelToolCalls: false, metadata: { promptVersion: 'test', docFingerprint: 'test', headNodeId: 0, baseSeq: 0 } },
                        key, url
                    );
                case 'custom-http-json':
                    return buildCustomHttpJsonRequest(
                        { task: 'summarize_node', model, system: '', messages: [{ role: 'user', content: 'Hi' }], responseSchema: { type: 'object', properties: {} }, maxOutputTokens: 16, temperature: 0, topP: 1, toolMode: 'none', parallelToolCalls: false, metadata: { promptVersion: 'test', docFingerprint: 'test', headNodeId: 0, baseSeq: 0 } },
                        key, url
                    );
            }
        };

        const controller = new AbortController();
        const timeoutMs = 30000;
        const timeoutId = setTimeout(() => {
            try { controller.abort('Connection timeout'); } catch { /* ignore */ }
        }, timeoutMs);

        try {
            const httpReq = buildRequest(baseUrl, apiKey);
            const response = await fetch(httpReq.url, {
                method: httpReq.method,
                headers: httpReq.headers,
                body: httpReq.body,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            outputChannel.appendLine(`CtrlZTree: Test connection ${provider} status=${response.status}`);

            if (response.ok) {
                vscode.window.showInformationMessage(`CtrlZTree: Connection to ${provider} (${model}) successful ✓`);
            } else if (response.status === 401 || response.status === 403) {
                vscode.window.showErrorMessage(`CtrlZTree: Authentication failed (${response.status}). Check your API key.`);
            } else {
                vscode.window.showWarningMessage(`CtrlZTree: Server returned ${response.status}. Provider may not support this model or endpoint.`);
            }
        } catch (e: any) {
            clearTimeout(timeoutId);
            const redactedErr = redactSensitiveData(e.message || 'Unknown error');
            outputChannel.appendLine(`CtrlZTree: Test connection error: ${redactedErr.redacted}`);
            if (e.name === 'AbortError' || (e.message && e.message.includes('timeout'))) {
                vscode.window.showErrorMessage(`CtrlZTree: Connection timed out after ${timeoutMs / 1000}s. Check your network and endpoint.`);
            } else {
                vscode.window.showErrorMessage(`CtrlZTree: Connection failed: ${redactedErr.redacted.substring(0, 200)}`);
            }
        }
    });

    context.subscriptions.push(undoCommand, redoCommand, visualizeCommand, setApiKeyCommand, clearApiKeyCommand, testConnectionCommand);

    outputChannel.appendLine('CtrlZTree: Extension activation completed successfully.');
}

export function deactivate() {
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
    editTokens: ApplyEditTokenSet
): Promise<ApplyEditResult> {
    const docId = document.uri.toString();
    const token = editTokens.begin(docId, reason);
    try {
        const content = tree.getContent();
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

async function applyRedoBranch(
    tree: CtrlZTree,
    targetHash: string,
    document: vscode.TextDocument,
    webviewManager: WebviewManager,
    editTokens: ApplyEditTokenSet
): Promise<ApplyEditResult> {
    const savedHead = tree.getHead();
    tree.setHead(targetHash);
    const result = await applyTreeStateToDocument(document, tree, 'redo', editTokens);
    if (result.ok) {
        await markEditorCleanIfAtInitialSnapshot(tree, document);
        updatePanelForDocument(tree, document.uri.toString(), webviewManager);
    } else if (savedHead) {
        tree.setHead(savedHead);
    }
    return result;
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