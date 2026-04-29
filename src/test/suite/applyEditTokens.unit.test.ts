import * as assert from 'assert';
import { ApplyEditTokenSet } from '../../concurrency/applyEditTokens';

suite('ApplyEditTokenSet', () => {
	let tokenSet: ApplyEditTokenSet;

	setup(() => {
		tokenSet = new ApplyEditTokenSet();
	});

	test('isApplying returns false when no tokens are active', () => {
		assert.strictEqual(tokenSet.isApplying('doc1'), false);
	});

	test('isApplying returns true after begin', () => {
		tokenSet.begin('doc1', 'undo');
		assert.strictEqual(tokenSet.isApplying('doc1'), true);
	});

	test('isApplying returns false after begin then end', () => {
		const token = tokenSet.begin('doc1', 'undo');
		tokenSet.end(token);
		assert.strictEqual(tokenSet.isApplying('doc1'), false);
	});

	test('multiple tokens for same doc tracked independently', () => {
		const t1 = tokenSet.begin('doc1', 'undo');
		const t2 = tokenSet.begin('doc1', 'redo');
		assert.strictEqual(tokenSet.isApplying('doc1'), true);
		tokenSet.end(t1);
		assert.strictEqual(tokenSet.isApplying('doc1'), true);
		tokenSet.end(t2);
		assert.strictEqual(tokenSet.isApplying('doc1'), false);
	});

	test('different documents tracked independently', () => {
		tokenSet.begin('doc1', 'undo');
		assert.strictEqual(tokenSet.isApplying('doc1'), true);
		assert.strictEqual(tokenSet.isApplying('doc2'), false);
	});

	test('end on non-existent token does not throw', () => {
		tokenSet.end({ id: 'none', docId: 'doc1', reason: 'undo' });
		assert.strictEqual(tokenSet.isApplying('doc1'), false);
	});

	test('begin returns token with correct properties', () => {
		const token = tokenSet.begin('doc1', 'checkout');
		assert.strictEqual(token.docId, 'doc1');
		assert.strictEqual(token.reason, 'checkout');
		assert.ok(typeof token.id === 'string');
		assert.ok(token.id.length > 0);
	});

	test('each begin returns unique token id', () => {
		const t1 = tokenSet.begin('doc1', 'undo');
		const t2 = tokenSet.begin('doc2', 'redo');
		assert.notStrictEqual(t1.id, t2.id);
	});

	test('getActive returns count of active tokens', () => {
		assert.strictEqual(tokenSet.getActive('doc1'), 0);
		tokenSet.begin('doc1', 'undo');
		assert.strictEqual(tokenSet.getActive('doc1'), 1);
		tokenSet.begin('doc1', 'redo');
		assert.strictEqual(tokenSet.getActive('doc1'), 2);
	});

	test('clear removes all tokens', () => {
		tokenSet.begin('doc1', 'undo');
		tokenSet.begin('doc2', 'redo');
		tokenSet.clear();
		assert.strictEqual(tokenSet.isApplying('doc1'), false);
		assert.strictEqual(tokenSet.isApplying('doc2'), false);
	});

	test('end does not affect other documents', () => {
		const t1 = tokenSet.begin('doc1', 'undo');
		tokenSet.begin('doc2', 'redo');
		tokenSet.end(t1);
		assert.strictEqual(tokenSet.isApplying('doc1'), false);
		assert.strictEqual(tokenSet.isApplying('doc2'), true);
	});
});
