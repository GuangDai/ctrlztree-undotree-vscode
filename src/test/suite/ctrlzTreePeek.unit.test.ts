import * as assert from 'assert';
import { CtrlZTree } from '../../model/ctrlZTree';

suite('CtrlZTree peek methods', () => {
	test('peekUndo returns parent without moving head', () => {
		const tree = new CtrlZTree('initial');
		const headBefore = tree.getHead();
		const addHash = tree.set('modified content');

		assert.ok(addHash);
		assert.strictEqual(tree.getHead(), addHash);

		const peeked = tree.peekUndo();
		assert.ok(peeked);
		assert.strictEqual(peeked, headBefore);
		assert.strictEqual(tree.getHead(), addHash);
	});

	test('peekUndo returns null at initial snapshot', () => {
		const tree = new CtrlZTree('initial');
		const initialHead = tree.getHead();
		if (initialHead) {
			tree.setHead(initialHead);
		}
		assert.strictEqual(tree.peekUndo(), null);
	});

	test('peekRedoChildren returns children without moving head', () => {
		const tree = new CtrlZTree('v1');
		const headBefore = tree.getHead();
		const v2 = tree.set('v2');

		// Move back
		tree.setHead(headBefore!);
		const children = tree.peekRedoChildren();
		assert.strictEqual(children.length, 1);
		assert.strictEqual(children[0], v2);
		assert.strictEqual(tree.getHead(), headBefore);
	});

	test('peekRedoChildren returns empty at tip', () => {
		const tree = new CtrlZTree('v1');
		tree.set('v2');
		assert.deepStrictEqual(tree.peekRedoChildren(), []);
	});

	test('undo head rollback on peek-then-sethead pattern', () => {
		const tree = new CtrlZTree('v1');
		const v2 = tree.set('v2');
		const v3 = tree.set('v3');

		const candidate = tree.peekUndo();
		assert.strictEqual(candidate, v2);

		const savedHead = tree.getHead();
		tree.setHead(candidate!);
		// Simulate apply failure - rollback
		tree.setHead(savedHead!);
		assert.strictEqual(tree.getHead(), v3);
	});
});
