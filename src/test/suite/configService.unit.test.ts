import * as assert from 'assert';
import { clampConfig } from '../../config/configService';

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
