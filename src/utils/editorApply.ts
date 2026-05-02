import * as vscode from 'vscode';

export type ApplyEditResult =
	| { ok: true }
	| { ok: false; error: string };

export async function applyEditAndVerify(document: vscode.TextDocument, targetContent: string): Promise<ApplyEditResult> {
	const edit = new vscode.WorkspaceEdit();
	const lastLineIndex = Math.max(0, document.lineCount - 1);
	const endChar = document.lineCount === 0 ? 0 : document.lineAt(lastLineIndex).text.length;
	const fullRange = new vscode.Range(0, 0, lastLineIndex, endChar);

	// Normalize target content EOL to match document's EOL setting
	const normalizedContent = normalizeEOL(targetContent, document.eol);

	edit.replace(document.uri, fullRange, normalizedContent);

	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		return { ok: false, error: 'WorkspaceEdit was rejected' };
	}

	const currentContent = document.getText();
	const currentNormalized = normalizeEOL(currentContent, document.eol);
	if (currentNormalized !== normalizedContent) {
		// Check if mismatch is formatting-only (common with formatters like Prettier)
		const whitespaceOnly = currentNormalized.replace(/\s+/g, ' ') === normalizedContent.replace(/\s+/g, ' ');
		const hint = whitespaceOnly
			? ' (content differs only in whitespace — a formatter may have run post-edit)'
			: '';
		return { ok: false, error: `Document content does not match target content after apply${hint}` };
	}

	return { ok: true };
}

function normalizeEOL(content: string, eol: vscode.EndOfLine): string {
	if (eol === vscode.EndOfLine.CRLF) {
		// Normalize to CRLF
		return content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
	}
	// LF mode: normalize any CRLF to LF
	return content.replace(/\r\n/g, '\n');
}
