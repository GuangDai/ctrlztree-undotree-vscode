import * as vscode from 'vscode';
import { CtrlZTree } from '../model/ctrlZTree';
import { ExtensionState, ChangeType } from '../state/extensionState';
import { WebviewManager } from '../webview/webviewManager';
import { DIFF_SCHEME } from '../constants';
import { ApplyEditTokenSet } from '../concurrency/applyEditTokens';
import { HistoryController } from '../history/historyController';
import { Logger } from '../utils/logger';

interface ChangeTrackerDeps {
    context: vscode.ExtensionContext;
    outputChannel: vscode.OutputChannel;
    state: ExtensionState;
    getOrCreateTree: (document: vscode.TextDocument) => CtrlZTree;
    getOrCreateController?: (document: vscode.TextDocument) => Promise<HistoryController>;
    webviewManager: WebviewManager;
    editTokens: ApplyEditTokenSet;
    setLastValidEditorUri: (uri: string | null) => void;
    actionTimeout: number;
    pauseThreshold: number;
    onDocumentCommitted?: (docUri: string, tree: CtrlZTree) => void;
}

const WHITESPACE_FLUSH_DELAY = 500; // 500 ms
const MAX_RESCHEDULE_RETRIES = 10;
const RESCHEDULE_DELAY = 200;

export function registerDocumentChangeTracking(deps: ChangeTrackerDeps): vscode.Disposable {
    const {
        context,
        state,
        getOrCreateTree,
        webviewManager,
        editTokens,
        setLastValidEditorUri,
        actionTimeout,
        pauseThreshold
    } = deps;

    const log = new Logger(deps.outputChannel);
    const logLevel = vscode.workspace.getConfiguration('ctrlztree').get<string>('logging.level', 'info') as any;
    log.setLevel(logLevel || 'info');

    const { documentChangeTimeouts, pendingChanges, lastChangeTime, lastCursorPosition, lastChangeType, processingDocuments, activeVisualizationPanels } = state;

    const subscription = vscode.workspace.onDidChangeTextDocument(async event => {
        const docUriString = event.document.uri.toString();

        if (editTokens.isApplying(docUriString)) {
            log.debug('CtrlZTree: skipping change due to active edit token.');
            return;
        }

        if (event.document.uri.scheme === DIFF_SCHEME) {
            return;
        }

        const editorForDoc = vscode.window.visibleTextEditors.find(e => e.document === event.document);
        if (editorForDoc && editorForDoc.document.uri.scheme !== 'file' && editorForDoc.document.uri.scheme !== 'untitled') {
            return;
        }

        if (event.document.uri.scheme !== 'file' && event.document.uri.scheme !== 'untitled') {
            return;
        }

        setLastValidEditorUri(docUriString);

        const currentText = event.document.getText();
        const activeEditor = vscode.window.activeTextEditor;

        let currentPosition: vscode.Position | undefined;
        if (activeEditor && activeEditor.document.uri.toString() === docUriString) {
            currentPosition = activeEditor.selection.active;
        }

        const tree = getOrCreateTree(event.document);
        const lastContent = tree.getContent();
        const changeType = detectChangeType(lastContent, currentText);
        const shouldGroup = currentPosition ? shouldGroupWithPreviousChange(state, docUriString, currentPosition, changeType, pauseThreshold) : false;
        const separatorTrigger = detectSeparatorTrigger(event.contentChanges);

        lastChangeTime.set(docUriString, Date.now());
        if (currentPosition) {
            lastCursorPosition.set(docUriString, currentPosition);
        }
        lastChangeType.set(docUriString, changeType);
        pendingChanges.set(docUriString, currentText);

        const existingTimeout = documentChangeTimeouts.get(docUriString);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
            documentChangeTimeouts.delete(docUriString);
        }

        if (separatorTrigger === 'newline') {
            processDocumentChange(event.document, currentText);
            log.debug(`CtrlZTree: newline flush due to newline separator for ${docUriString}.`);
            return;
        }

        const delay = separatorTrigger === 'whitespace'
            ? WHITESPACE_FLUSH_DELAY
            : shouldGroup ? actionTimeout : 50;
        const newTimeout = setTimeout(() => {
            const pendingContent = pendingChanges.get(docUriString);
            if (pendingContent !== undefined) {
                processDocumentChange(event.document, pendingContent);
            }
            documentChangeTimeouts.delete(docUriString);
        }, delay);

        documentChangeTimeouts.set(docUriString, newTimeout);
        log.debug(`CtrlZTree: change scheduled for ${docUriString} (group: ${shouldGroup}, separatorTrigger: ${separatorTrigger ?? 'none'}, delay: ${delay}ms, type: ${changeType}, cursor: ${currentPosition?.line}:${currentPosition?.character})`);
    });

    context.subscriptions.push(subscription);
    log.info('CtrlZTree: onDidChangeTextDocument subscribed.');

    return subscription;

    async function processDocumentChange(document: vscode.TextDocument, content: string) {
        const docUriString = document.uri.toString();

        if (processingDocuments.has(docUriString)) {
            const retryCount = (state.rescheduleRetryCounts?.get(docUriString) ?? 0) + 1;
            if (retryCount > MAX_RESCHEDULE_RETRIES) {
                log.warn(`CtrlZTree: ${docUriString} exceeded max reschedule retries (${MAX_RESCHEDULE_RETRIES}); dropping change`);
                pendingChanges.delete(docUriString);
                state.rescheduleRetryCounts?.delete(docUriString);
                return;
            }
            state.rescheduleRetryCounts.set(docUriString, retryCount);
            log.debug(`CtrlZTree: rescheduling ${docUriString} (retry ${retryCount}/${MAX_RESCHEDULE_RETRIES}) due to ongoing processing.`);
            // Capture content in closure to avoid reading stale pendingChanges after delay
            const capturedContent = content;
            pendingChanges.set(docUriString, capturedContent);
            const timeout = setTimeout(() => {
                const pendingContent = pendingChanges.get(docUriString);
                if (pendingContent !== undefined) {
                    processDocumentChange(document, pendingContent);
                }
            }, RESCHEDULE_DELAY);
            documentChangeTimeouts.set(docUriString, timeout);
            return;
        }

        try {
            processingDocuments.add(docUriString);

            const tree = getOrCreateTree(document);
            const currentTreeContent = tree.getContent();

            if (content !== currentTreeContent) {
                let cursorPosition: vscode.Position | undefined;
                const editor = vscode.window.activeTextEditor;
                if (editor && editor.document.uri.toString() === docUriString) {
                    cursorPosition = editor.selection.active;
                }

                const controller = await deps.getOrCreateController?.(document);
                if (controller) {
                    try {
                        await controller.commit(content, cursorPosition);
                        log.info('CtrlZTree: Document changed and processed via HistoryController (debounced).');
                    } catch (err: any) {
                        log.error(`CtrlZTree: HistoryController commit error: ${err.message}`);
                    }
                } else {
                    tree.set(content, cursorPosition);
                }
                log.debug('CtrlZTree: change processed.');

                if (deps.onDocumentCommitted) {
                    deps.onDocumentCommitted(docUriString, tree);
                }

                const panel = activeVisualizationPanels.get(docUriString);
                if (panel) {
                    webviewManager.postUpdatesToWebview(panel, tree, docUriString);
                    log.debug(`CtrlZTree: panel updated ${docUriString} updated after file change.`);
                } else {
                    log.debug(`CtrlZTree: no panel for ${docUriString} on file change.`);
                }
            } else {
                log.debug('CtrlZTree: content matches tree - skipping update.');
            }
        } catch (e: any) {
            log.error(`CtrlZTree: processDocumentChange error: ${e.message} Stack: ${e.stack}`);
            vscode.window.showErrorMessage(`CtrlZTree processDocumentChange error: ${e.message}`);
        } finally {
            processingDocuments.delete(docUriString);
            pendingChanges.delete(docUriString);
            state.rescheduleRetryCounts?.delete(docUriString);
        }
    }
}

function shouldGroupWithPreviousChange(
    state: ExtensionState,
    docUriString: string,
    currentPosition: vscode.Position,
    changeType: ChangeType,
    pauseThreshold: number
): boolean {
    const lastTime = state.lastChangeTime.get(docUriString);
    const lastPos = state.lastCursorPosition.get(docUriString);
    const lastType = state.lastChangeType.get(docUriString);
    const now = Date.now();

    if (!lastTime || !lastPos || !lastType) {
        return false;
    }

    if (now - lastTime > pauseThreshold) {
        return false;
    }

    if (changeType !== lastType) {
        return false;
    }

    const lineDiff = Math.abs(currentPosition.line - lastPos.line);
    const charDiff = Math.abs(currentPosition.character - lastPos.character);

    if (lineDiff > 1) {
        return false;
    }

    if (lineDiff === 0 && charDiff > 20) {
        return false;
    }

    if (lineDiff === 1 && charDiff > 10) {
        return false;
    }

    return true;
}

function detectChangeType(oldContent: string, newContent: string): ChangeType {
    const lengthDiff = newContent.length - oldContent.length;

    if (lengthDiff > 0) {
        return 'typing';
    }
    if (lengthDiff < 0) {
        return 'deletion';
    }
    return oldContent === newContent ? 'other' : 'typing';
}

type SeparatorTrigger = 'newline' | 'whitespace';

function detectSeparatorTrigger(changes: readonly vscode.TextDocumentContentChangeEvent[]): SeparatorTrigger | null {
    let sawWhitespace = false;

    for (const change of changes) {
        if (!change.text) {
            continue;
        }

        if (/\r|\n/.test(change.text)) {
            return 'newline';
        }

        if (change.text.trim() === '') {
            sawWhitespace = true;
        }
    }

    return sawWhitespace ? 'whitespace' : null;
}
