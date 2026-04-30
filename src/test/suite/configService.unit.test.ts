import * as assert from 'assert';
import { clampConfig, clampAiConfig } from '../../config/configService';

suite('ConfigService clampConfig', () => {
	test('returns defaults when raw is empty', () => {
		const result = clampConfig({});
		assert.strictEqual(result.enablePruning, true);
		assert.strictEqual(result.maxHistoryNodesPerDocument, 1000);
		assert.strictEqual(result.maxTrackedDocuments, 100);
	});

	test('accepts valid boolean for enablePruning', () => {
		assert.strictEqual(clampConfig({ enablePruning: false }).enablePruning, false);
		assert.strictEqual(clampConfig({ enablePruning: true }).enablePruning, true);
	});

	test('falls back to default for non-boolean enablePruning', () => {
		assert.strictEqual(clampConfig({ enablePruning: 1 as unknown as boolean }).enablePruning, true);
		assert.strictEqual(clampConfig({ enablePruning: 'true' as unknown as boolean }).enablePruning, true);
	});

	test('accepts valid maxHistoryNodesPerDocument', () => {
		assert.strictEqual(clampConfig({ maxHistoryNodesPerDocument: 500 }).maxHistoryNodesPerDocument, 500);
		assert.strictEqual(clampConfig({ maxHistoryNodesPerDocument: 1000 }).maxHistoryNodesPerDocument, 1000);
	});

	test('clamps maxHistoryNodesPerDocument below minimum', () => {
		const result = clampConfig({ maxHistoryNodesPerDocument: 10 });
		assert.strictEqual(result.maxHistoryNodesPerDocument, 50);
	});

	test('clamps maxHistoryNodesPerDocument above maximum', () => {
		const result = clampConfig({ maxHistoryNodesPerDocument: 200000 });
		assert.strictEqual(result.maxHistoryNodesPerDocument, 100000);
	});

	test('clamps maxHistoryNodesPerDocument for negative value', () => {
		const result = clampConfig({ maxHistoryNodesPerDocument: -1 });
		assert.strictEqual(result.maxHistoryNodesPerDocument, 50);
	});

	test('falls back to default for NaN maxHistoryNodesPerDocument', () => {
		const result = clampConfig({ maxHistoryNodesPerDocument: NaN });
		assert.strictEqual(result.maxHistoryNodesPerDocument, 1000);
	});

	test('falls back to default for Infinity maxHistoryNodesPerDocument', () => {
		const result = clampConfig({ maxHistoryNodesPerDocument: Infinity });
		assert.strictEqual(result.maxHistoryNodesPerDocument, 1000);
	});

	test('falls back to default for non-number maxHistoryNodesPerDocument', () => {
		assert.strictEqual(
			clampConfig({ maxHistoryNodesPerDocument: 'abc' as unknown as number }).maxHistoryNodesPerDocument,
			1000
		);
	});

	test('accepts valid maxTrackedDocuments', () => {
		assert.strictEqual(clampConfig({ maxTrackedDocuments: 50 }).maxTrackedDocuments, 50);
	});

	test('clamps maxTrackedDocuments below minimum', () => {
		const result = clampConfig({ maxTrackedDocuments: 0 });
		assert.strictEqual(result.maxTrackedDocuments, 1);
	});

	test('clamps maxTrackedDocuments above maximum', () => {
		const result = clampConfig({ maxTrackedDocuments: 50000 });
		assert.strictEqual(result.maxTrackedDocuments, 10000);
	});

	test('falls back to default for NaN maxTrackedDocuments', () => {
		const result = clampConfig({ maxTrackedDocuments: NaN });
		assert.strictEqual(result.maxTrackedDocuments, 100);
	});

	test('composition: multiple fields clamped simultaneously', () => {
		const result = clampConfig({
			enablePruning: false,
			maxHistoryNodesPerDocument: 0,
			maxTrackedDocuments: 99999
		});
		assert.strictEqual(result.enablePruning, false);
		assert.strictEqual(result.maxHistoryNodesPerDocument, 50);
		assert.strictEqual(result.maxTrackedDocuments, 10000);
	});

	test('undefined values do not cause clamping warnings', () => {
		const result = clampConfig({ enablePruning: undefined });
		assert.strictEqual(result.enablePruning, true);
		assert.strictEqual(result.maxHistoryNodesPerDocument, 1000);
		assert.strictEqual(result.maxTrackedDocuments, 100);
	});
});

suite('ConfigService clampAiConfig', () => {
	test('returns defaults when raw is empty', () => {
		const result = clampAiConfig({});
		assert.strictEqual(result.enabled, false);
		assert.strictEqual(result.provider, 'openai-chat-compatible');
		assert.strictEqual(result.valid, true);
	});

	test('accepts valid AI config', () => {
		const result = clampAiConfig({
			enabled: true,
			provider: 'anthropic-messages',
			model: 'claude-sonnet-4-6',
			baseUrl: 'https://api.anthropic.com/v1/messages',
		});
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.enabled, true);
		assert.strictEqual(result.provider, 'anthropic-messages');
		assert.strictEqual(result.model, 'claude-sonnet-4-6');
	});

	test('rejects invalid provider', () => {
		const result = clampAiConfig({ provider: 'invalid-provider' });
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('Invalid')));
		assert.strictEqual(result.provider, 'openai-chat-compatible');
	});

	test('rejects empty model when enabled', () => {
		const result = clampAiConfig({ enabled: true, model: '' });
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('model')));
	});

	test('accepts empty model when disabled', () => {
		const result = clampAiConfig({ enabled: false, model: '' });
		assert.strictEqual(result.valid, true);
	});

	test('rejects invalid baseUrl format', () => {
		const result = clampAiConfig({ enabled: true, model: 'gpt', baseUrl: 'not-a-url' });
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('baseUrl')));
	});

	test('accepts HTTP localhost baseUrl', () => {
		const result = clampAiConfig({ enabled: true, model: 'test', baseUrl: 'http://localhost:8080' });
		assert.strictEqual(result.valid, true);
	});

	test('rejects FTP baseUrl', () => {
		const result = clampAiConfig({ enabled: true, model: 'test', baseUrl: 'ftp://example.com' });
		assert.strictEqual(result.valid, false);
	});

	test('all four valid providers accepted', () => {
		for (const p of ['openai-chat-compatible', 'openai-responses', 'anthropic-messages', 'custom-http-json']) {
			const result = clampAiConfig({ provider: p });
			assert.strictEqual(result.provider, p, `provider ${p} should be accepted`);
			assert.strictEqual(result.valid, !result.errors.length, `provider ${p} should be valid`);
		}
	});
});
