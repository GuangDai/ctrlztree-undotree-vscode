/**
 * Merge command — squash a linear chain of history nodes into one.
 *
 * COMMANDS REGISTERED:
 *   ctrlztree.history.mergeChain — Find linear chain on head path, propose merge, execute
 *
 * KEY EXPORTS:
 *   registerMergeCommand(context, deps) — registers the merge command
 *
 * ARCHITECTURAL ROLE:
 *   Command glue layer (src/commands/). Calls generateMergePlan() from history/mergeEngine
 *   and HistoryController.executeMergePlan().
 */

import * as vscode from 'vscode';
import { HistoryTreeProvider } from '../ui/historyTreeProvider';
import { HistoryController } from '../history/historyController';
import { generateMergePlan } from '../history/mergeEngine';
import { Logger } from '../utils/logger';
import { isTrackableDocument } from '../utils/extensionUtils';

export interface MergeCommandDeps {
    historyTreeProvider: HistoryTreeProvider;
    getOrCreateController: (document: vscode.TextDocument) => Promise<HistoryController>;
    log: Logger;
}

export function registerMergeCommand(
    context: vscode.ExtensionContext,
    deps: MergeCommandDeps
): void {
    const { historyTreeProvider, getOrCreateController, log } = deps;

    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.history.mergeChain', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isTrackableDocument(editor.document)) { return; }

            const controller = await getOrCreateController(editor.document);
            const proj = controller.getProjection();

            // Find all nodes on head-to-root path that form a linear chain
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

                const resultContent = controller.getContent();
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
        })
    );
}
