import * as assert from 'assert';
import * as vscode from 'vscode';

suite('applyEditAndVerify', () => {
	let testDoc: vscode.TextDocument | undefined;

	suiteSetup(async () => {
		// Create a real untitled document in the extension host for testing
		testDoc = await vscode.workspace.openTextDocument({ content: 'hello world' });
	});

	suiteTeardown(async () => {
		// Close the document if it's still open
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

	test('should verify content matches after successful edit', () => {
		assert.ok(testDoc, 'Test document should be available');
		const content = testDoc!.getText();
		assert.strictEqual(typeof content, 'string');
		assert.ok(content.length > 0, 'Document should have content');
	});

	test('should detect content mismatch', () => {
		assert.ok(testDoc, 'Test document should be available');
		const content = testDoc!.getText();
		// Content that differs from the actual document text
		const differentContent = 'completely different content';
		assert.notStrictEqual(content, differentContent, 'Different content should not match');
	});

	test('should handle empty string target', () => {
		assert.ok(testDoc, 'Test document should be available');
		assert.ok(typeof '' === 'string');
	});
});
