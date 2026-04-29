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

const extensionState = createExtensionState();

// Helper moved to top-level so it's available to commands and initialization
function isTrackableDocument(document: vscode.TextDocument | undefined): document is vscode.TextDocument {
    return !!document && (document.uri.scheme === 'file' || document.uri.scheme === 'untitled');
}

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('CtrlZTree');
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine('CtrlZTree: Extension activating...');

    const editTokens = new ApplyEditTokenSet();

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

        // Prune if tree exceeds max nodes (only if pruning enabled)
        if (config.enablePruning && tree.getNodeCount() > config.maxHistoryNodesPerDocument) {
            tree.pruneToMaxNodes(Math.floor(config.maxHistoryNodesPerDocument * 0.95));
            outputChannel.appendLine(`CtrlZTree: Pruned history for ${key} (now ${tree.getNodeCount()} nodes)`);
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

    const webviewManager = createWebviewManager({
        context,
        outputChannel,
        state: extensionState,
        getOrCreateTree,
        editTokens,
        diffContentRegistry
    });

    const changeTracker = registerDocumentChangeTracking({
        context,
        outputChannel,
        state: extensionState,
        getOrCreateTree,
        webviewManager,
        editTokens,
        setLastValidEditorUri: uri => {
            extensionState.lastValidEditorUri = uri;
        },
        actionTimeout: ACTION_TIMEOUT,
        pauseThreshold: PAUSE_THRESHOLD
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

    const undoCommand = vscode.commands.registerCommand('ctrlztree.undo', async () => {
        const editor = vscode.window.activeTextEditor;
        
        // Pass through to native undo if no editor or untrackable document
        if (!editor || !isTrackableDocument(editor.document)) {
            await vscode.commands.executeCommand('undo');
            return;
        }

        const document = editor.document;
        const tree = getOrCreateTree(document);
        const previousHead = tree.getHead();
        const newHead = tree.z();

        if (!newHead) {
            outputChannel.appendLine('CtrlZTree: No more undo history.');
            vscode.window.showInformationMessage('CtrlZTree: No more undo history.');
            return;
        }

        outputChannel.appendLine(`CtrlZTree: Undo from ${previousHead} to ${newHead}`);
        await applyTreeStateToDocument(document, tree, 'undo', editTokens);
        await markEditorCleanIfAtInitialSnapshot(tree, document, { outputChannel });
        updatePanelForDocument(tree, document.uri.toString(), webviewManager);
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
        const redoResult = tree.y();

        if (typeof redoResult === 'string') {
            await applyRedoBranch(tree, redoResult, document, webviewManager, editTokens);
            return;
        }

        if (redoResult.length === 0) {
            outputChannel.appendLine('CtrlZTree: No more redo history.');
            vscode.window.showInformationMessage('CtrlZTree: No more redo history.');
            return;
        }

        const currentContent = tree.getContent();
        const items = redoResult.map(hash => {
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

        await applyRedoBranch(tree, selected.hash, document, webviewManager, editTokens);
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

    context.subscriptions.push(undoCommand, redoCommand, visualizeCommand);

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
    tree.setHead(targetHash);
    const result = await applyTreeStateToDocument(document, tree, 'redo', editTokens);
    if (result.ok) {
        await markEditorCleanIfAtInitialSnapshot(tree, document);
        updatePanelForDocument(tree, document.uri.toString(), webviewManager);
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