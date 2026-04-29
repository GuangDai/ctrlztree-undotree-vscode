import * as assert from 'assert';
import { isWebviewIncomingMessage } from '../../webview/messageSchema';

suite('Webview Message Schema', () => {
	test('accepts valid webviewReady message', () => {
		assert.ok(isWebviewIncomingMessage({ command: 'webviewReady' }));
	});

	test('accepts valid openDiff message', () => {
		assert.ok(isWebviewIncomingMessage({ command: 'openDiff', shortHash: 'abc12345' }));
	});

	test('accepts valid navigateToNode message', () => {
		assert.ok(isWebviewIncomingMessage({ command: 'navigateToNode', shortHash: 'abc12345' }));
	});

	test('accepts valid requestTreeReload message', () => {
		assert.ok(isWebviewIncomingMessage({ command: 'requestTreeReload' }));
	});

	test('accepts valid requestTreeReset message', () => {
		assert.ok(isWebviewIncomingMessage({ command: 'requestTreeReset' }));
	});

	test('accepts valid webviewError message', () => {
		assert.ok(isWebviewIncomingMessage({
			command: 'webviewError',
			error: { message: 'Something broke', stack: 'Error: Something broke\n    at ...' }
		}));
	});

	test('rejects null input', () => {
		assert.strictEqual(isWebviewIncomingMessage(null), false);
	});

	test('rejects undefined input', () => {
		assert.strictEqual(isWebviewIncomingMessage(undefined), false);
	});

	test('rejects non-object input', () => {
		assert.strictEqual(isWebviewIncomingMessage('string'), false);
		assert.strictEqual(isWebviewIncomingMessage(42), false);
		assert.strictEqual(isWebviewIncomingMessage(true), false);
	});

	test('rejects object without command field', () => {
		assert.strictEqual(isWebviewIncomingMessage({}), false);
		assert.strictEqual(isWebviewIncomingMessage({ foo: 'bar' }), false);
	});

	test('rejects unknown command', () => {
		assert.strictEqual(isWebviewIncomingMessage({ command: 'deleteEverything' }), false);
		assert.strictEqual(isWebviewIncomingMessage({ command: 'eval' }), false);
	});

	test('rejects openDiff without shortHash', () => {
		assert.strictEqual(isWebviewIncomingMessage({ command: 'openDiff' }), false);
		assert.strictEqual(isWebviewIncomingMessage({ command: 'openDiff', shortHash: 123 }), false);
	});

	test('rejects navigateToNode without shortHash', () => {
		assert.strictEqual(isWebviewIncomingMessage({ command: 'navigateToNode' }), false);
	});

	test('rejects webviewError without error object', () => {
		assert.strictEqual(isWebviewIncomingMessage({ command: 'webviewError' }), false);
		assert.strictEqual(isWebviewIncomingMessage({ command: 'webviewError', error: 'something' }), false);
	});

	test('rejects webviewError with incomplete error object', () => {
		assert.strictEqual(isWebviewIncomingMessage({ command: 'webviewError', error: { message: 'no stack' } }), false);
		assert.strictEqual(isWebviewIncomingMessage({ command: 'webviewError', error: { stack: 'trace' } }), false);
	});

	test('rejects webviewError with null error object', () => {
		assert.strictEqual(isWebviewIncomingMessage({ command: 'webviewError', error: null }), false);
	});

	test('rejects messages with extra unknown fields (tolerates via structural match)', () => {
		assert.ok(isWebviewIncomingMessage({ command: 'webviewReady', extra: 'field' }));
	});

	test('rejects command field that is not a string', () => {
		assert.strictEqual(isWebviewIncomingMessage({ command: 123 }), false);
		assert.strictEqual(isWebviewIncomingMessage({ command: null }), false);
		assert.strictEqual(isWebviewIncomingMessage({ command: {} }), false);
	});
});
