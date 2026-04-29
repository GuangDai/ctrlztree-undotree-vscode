import * as vscode from 'vscode';

export type ApplyEditResult =
	| { ok: true }
	| { ok: false; error: string };

export async function applyEditAndVerify(document: vscode.TextDocument, targetContent: string): Promise<ApplyEditResult> {
	const edit = new vscode.WorkspaceEdit();
	const lastLineIndex = Math.max(0, document.lineCount - 1);
	const endChar = document.lineCount === 0 ? 0 : document.lineAt(lastLineIndex).text.length;
	const fullRange = new vscode.Range(0, 0, lastLineIndex, endChar);
	edit.replace(document.uri, fullRange, targetContent);

	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		return { ok: false, error: 'WorkspaceEdit was rejected' };
	}

	const currentContent = document.getText();
	if (currentContent !== targetContent) {
		return { ok: false, error: 'Document content does not match target content after apply' };
	}

	return { ok: true };
}
