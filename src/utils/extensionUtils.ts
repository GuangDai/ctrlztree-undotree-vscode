/**
 * Shared utility functions extracted from extension.ts.
 * Used by command modules (treeCommands, navigationCommands) and services (controllerManager).
 *
 * EXPORTS:
 *   isTrackableDocument(document) — type guard for file: and untitled: schemes
 *   applyTreeStateToDocument(document, tree, reason, editTokens, controller?) — applies tree state to editor
 *   maxNodeTimestamp(tree) — finds the maximum timestamp across all tree nodes
 */

import * as vscode from 'vscode';
import { CtrlZTree } from '../model/ctrlZTree';
import { HistoryController } from '../history/historyController';
import { ApplyEditTokenSet, ApplyEditToken } from '../concurrency/applyEditTokens';
import { applyEditAndVerify, ApplyEditResult } from './editorApply';

export function isTrackableDocument(document: vscode.TextDocument | undefined): document is vscode.TextDocument {
    return !!document && (document.uri.scheme === 'file' || document.uri.scheme === 'untitled');
}

export function maxNodeTimestamp(tree: CtrlZTree): number {
    let max = 0;
    for (const node of tree.getAllNodes().values()) {
        if (node.timestamp > max) {
            max = node.timestamp;
        }
    }
    return max;
}

export async function applyTreeStateToDocument(
    document: vscode.TextDocument,
    tree: CtrlZTree,
    reason: ApplyEditToken['reason'],
    editTokens: ApplyEditTokenSet,
    controller?: HistoryController
): Promise<ApplyEditResult> {
    const docId = document.uri.toString();
    const token = editTokens.begin(docId, reason);
    try {
        const content = controller ? controller.getContent() : tree.getContent();
        const cursorPosition = tree.getCursorPosition();

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
