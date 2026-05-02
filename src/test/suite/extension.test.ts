import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

suite('Extension Activation Test Suite', () => {
	test('extension should be present', () => {
		const ext = vscode.extensions.getExtension('4skl.ctrlztree');
		assert.ok(ext, 'CtrlZTree extension should be installed');
	});

	test('extension should activate on command', async () => {
		const ext = vscode.extensions.getExtension('4skl.ctrlztree');
		if (!ext) {
			assert.fail('CtrlZTree extension not found');
		}
		if (!ext.isActive) {
			await ext.activate();
		}
		assert.ok(ext.isActive, 'Extension should be activated');
	});

	test('undo/redo/visualize commands are registered', async () => {
		const commands = await vscode.commands.getCommands();
		assert.ok(commands.includes('ctrlztree.undo'), 'Undo command should be registered');
		assert.ok(commands.includes('ctrlztree.redo'), 'Redo command should be registered');
		assert.ok(commands.includes('ctrlztree.visualize'), 'Visualize command should be registered');
	});

	test('history tree view is registered', async () => {
		const commands = await vscode.commands.getCommands();
		assert.ok(commands.includes('ctrlztree.history.refresh'), 'Refresh command should be registered');
		assert.ok(commands.includes('ctrlztree.history.navigateToNode'), 'Navigate command should be registered');
		assert.ok(commands.includes('ctrlztree.history.diffWithParent'), 'Diff command should be registered');
	});

	test('AI key management commands are registered', async () => {
		const commands = await vscode.commands.getCommands();
		assert.ok(commands.includes('ctrlztree.ai.setApiKey'), 'Set API key command should be registered');
		assert.ok(commands.includes('ctrlztree.ai.clearApiKey'), 'Clear API key command should be registered');
		assert.ok(commands.includes('ctrlztree.ai.testConnection'), 'Test connection command should be registered');
	});

	test('CtrlZTree diffWithCurrent command is registered', async () => {
		const commands = await vscode.commands.getCommands();
		assert.ok(commands.includes('ctrlztree.history.diffWithCurrent'), 'Diff with current command should be registered');
	});
});
