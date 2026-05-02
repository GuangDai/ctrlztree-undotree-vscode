/**
 * Command registrations for tree navigation and diff viewing.
 *
 * COMMANDS REGISTERED:
 *   ctrlztree.history.refresh        — Refresh the history tree view
 *   ctrlztree.history.navigateToNode — Checkout to a historical node
 *   ctrlztree.history.diffWithParent — Diff a node against its parent
 *   ctrlztree.history.diffWithCurrent — Diff a node against current editor content
 *   ctrlztree.undo                   — Navigate to parent (undo)
 *   ctrlztree.redo                   — Navigate to child (redo), with branch picker for multi-branch
 *
 * KEY EXPORTS:
 *   registerTreeAndNavigationCommands(context, deps) — registers all 6 commands
 *
 * ARCHITECTURAL ROLE:
 *   Command glue layer (src/commands/). Imports VS Code APIs, calls into
 *   HistoryController and CtrlZTree for history operations.
 */

import * as vscode from 'vscode';
import { ExtensionState } from '../state/extensionState';
import { HistoryTreeProvider } from '../ui/historyTreeProvider';
import { HistoryController } from '../history/historyController';
import { CtrlZTree } from '../model/ctrlZTree';
import { DiffContentRegistry } from '../ui/diffContentRegistry';
import { ApplyEditTokenSet } from '../concurrency/applyEditTokens';
import { DIFF_SCHEME } from '../constants';
import { Logger } from '../utils/logger';
import { isTrackableDocument, applyTreeStateToDocument } from '../utils/extensionUtils';
import { generateDiffSummary } from '../lcs';
import { markEditorCleanIfAtInitialSnapshot } from '../utils/editorState';

export interface TreeAndNavCommandDeps {
    extensionState: ExtensionState;
    historyTreeProvider: HistoryTreeProvider;
    getOrCreateTree: (document: vscode.TextDocument) => CtrlZTree;
    getOrCreateController: (document: vscode.TextDocument) => Promise<HistoryController>;
    diffContentRegistry: DiffContentRegistry;
    editTokens: ApplyEditTokenSet;
    log: Logger;
    outputChannel: vscode.OutputChannel;
}

export function registerTreeAndNavigationCommands(
    context: vscode.ExtensionContext,
    deps: TreeAndNavCommandDeps
): void {
    const { extensionState, historyTreeProvider, getOrCreateTree, getOrCreateController, diffContentRegistry, editTokens, log } = deps;

    // ---- refresh ----
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.history.refresh', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && isTrackableDocument(editor.document)) {
                const controller = extensionState.historyControllers.get(editor.document.uri.toString());
                historyTreeProvider.setController(controller ?? null, editor.document.uri.toString());
            }
        })
    );

    // ---- navigateToNode ----
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.history.navigateToNode', async (item?: { nodeHash: string }) => {
            if (!item?.nodeHash) { return; }
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isTrackableDocument(editor.document)) { return; }

            const document = editor.document;
            const tree = getOrCreateTree(document);
            const controller = await getOrCreateController(document);

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

            const checkoutResult = await controller.checkout(item.nodeHash);
            if (!checkoutResult.success) {
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
            extensionState.pendingChanges.delete(document.uri.toString());
            historyTreeProvider.refresh();

            const docUriStr = document.uri.toString();
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
            const groupsToClean = new Set<vscode.TabGroup>();
            if (docGroup) {
                groupsToClean.add(docGroup);
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
            for (const ed of vscode.window.visibleTextEditors) {
                if (ed.document.uri.toString() === docUriStr) {
                    await vscode.window.showTextDocument(ed.document, ed.viewColumn);
                    break;
                }
            }
        })
    );

    // ---- diffWithParent ----
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.history.diffWithParent', async (item?: { nodeHash: string }) => {
            if (!item?.nodeHash) { return; }
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isTrackableDocument(editor.document)) { return; }

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

    // ---- diffWithCurrent ----
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.history.diffWithCurrent', async (item?: { nodeHash: string }) => {
            if (!item?.nodeHash) { return; }
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isTrackableDocument(editor.document)) { return; }

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

    // ---- undo ----
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.undo', async () => {
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
                if (savedHead) {
                    tree.setHead(savedHead);
                    controller.setHeadDirectly(savedHead);
                }
                return;
            }

            await markEditorCleanIfAtInitialSnapshot(tree, document, { outputChannel: deps.outputChannel });
            extensionState.pendingChanges.delete(document.uri.toString());
            historyTreeProvider.refresh();
        })
    );

    // ---- redo ----
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.redo', async () => {
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
                    tree.setHead(savedHead);
                    controller.setHeadDirectly(savedHead);
                }
                return;
            }
            await markEditorCleanIfAtInitialSnapshot(tree, document);
            extensionState.pendingChanges.delete(document.uri.toString());
            historyTreeProvider.refresh();
        })
    );
}
