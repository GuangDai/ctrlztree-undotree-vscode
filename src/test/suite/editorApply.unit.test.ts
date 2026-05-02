import * as assert from 'assert';
import * as vscode from 'vscode';

suite('applyEditAndVerify', () => {
	let testDoc: vscode.TextDocument | undefined;

	suiteSetup(async () => {
		testDoc = await vscode.workspace.openTextDocument({ content: 'hello world' });
	});

	suiteTeardown(async () => {
		if (testDoc && !testDoc.isClosed) {
			try {
				const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
				const tab = tabs.find(t => (t.input as any)?.uri?.toString() === testDoc!.uri.toString());
				if (tab) {
					await vscode.window.tabGroups.close(tab);
				}
			} catch {
				// Best effort cleanup
			}
		}
	});

	test('function is callable', () => {
		const { applyEditAndVerify } = require('../../utils/editorApply');
		assert.ok(typeof applyEditAndVerify === 'function');
		assert.strictEqual(applyEditAndVerify.length, 2);
	});

	test('returns ok when target content matches document text', async () => {
		const { applyEditAndVerify } = require('../../utils/editorApply');
		const content = testDoc!.getText();
		const result = await applyEditAndVerify(testDoc!, content);
		assert.strictEqual(result.ok, true, `Expected ok=true but got error: ${result.error}`);
	});

	test('returns not ok when target content differs from document text', async () => {
		const { applyEditAndVerify } = require('../../utils/editorApply');
		const result = await applyEditAndVerify(testDoc!, 'completely different content');
		assert.strictEqual(result.ok, false);
		// Error message should indicate a mismatch
		assert.ok(
			result.error?.toLowerCase().includes('match') || result.error?.toLowerCase().includes('content'),
			`Error should mention content mismatch, got: ${result.error}`
		);
	});

	test('handles empty string target gracefully', async () => {
		const { applyEditAndVerify } = require('../../utils/editorApply');
		const result = await applyEditAndVerify(testDoc!, '');
		assert.strictEqual(typeof result.ok, 'boolean', 'Should return a result with ok field');
	});
});
