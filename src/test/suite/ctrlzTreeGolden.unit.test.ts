import * as assert from 'assert';
import { CtrlZTree } from '../../model/ctrlZTree';

suite('CtrlZTree Golden Tests', () => {
	suite('Edit Behavior', () => {
		test('initial content is reconstructed correctly', () => {
			const tree = new CtrlZTree('hello world');
			assert.strictEqual(tree.getContent(), 'hello world');
		});

		test('single edit changes content and creates node', () => {
			const tree = new CtrlZTree('v1');
			const h1 = tree.set('v2');
			assert.ok(h1);
			assert.strictEqual(tree.getContent(), 'v2');
			assert.strictEqual(tree.getHead(), h1);
			assert.ok(tree.getNodeCount() >= 3); // empty root + initial + edit
		});

		test('multiple edits create linear chain', () => {
			const tree = new CtrlZTree('v1');
			tree.set('v2');
			tree.set('v3');
			tree.set('v4');
			assert.strictEqual(tree.getContent(), 'v4');
		});

		test('duplicate content does not create new node', () => {
			const tree = new CtrlZTree('v1');
			const h1 = tree.set('v2');
			const h2 = tree.set('v2');
			assert.strictEqual(h1, h2);
		});

		test('empty initial document works', () => {
			const tree = new CtrlZTree('');
			assert.strictEqual(tree.getContent(), '');
			const h = tree.set('non-empty');
			assert.strictEqual(tree.getContent(), 'non-empty');
			assert.ok(h);
		});
	});

	suite('Undo/Redo Behavior', () => {
		test('undo returns to previous content', () => {
			const tree = new CtrlZTree('v1');
			tree.set('v2');
			const undone = tree.z();
			assert.ok(undone);
			assert.strictEqual(tree.getContent(), 'v1');
		});

		test('undo at initial state returns null', () => {
			const tree = new CtrlZTree('v1');
			tree.setHead(tree.getInitialSnapshotHash()!);
			const result = tree.z();
			assert.strictEqual(result, null);
		});

		test('redo single child after undo', () => {
			const tree = new CtrlZTree('v1');
			const v2 = tree.set('v2');
			tree.z(); // undo
			const redoResult = tree.y();
			assert.strictEqual(redoResult, v2);
			assert.strictEqual(tree.getContent(), 'v2');
		});

		test('redo after branch returns array', () => {
			const tree = new CtrlZTree('v1');
			const v2 = tree.set('v2');
			tree.z(); // undo back to v1
			const v3 = tree.set('v3'); // branch A
			tree.z(); // undo back to v1
			const v4 = tree.set('v4'); // branch B
			tree.z(); // undo back to v1
			// head at v1, children are v2, v3, v4 (but v2 was from earlier, v3 and v4 are direct children)
			// Actually: v1 has children [v2, v3, v4] since each undo+new edit creates a new child
			const redoResult = tree.y();
			assert.ok(Array.isArray(redoResult));
		});

		test('content is correct after undo then edit (branching)', () => {
			const tree = new CtrlZTree('v1');
			tree.set('v2');
			tree.z(); // undo to v1
			tree.set('v3'); // new branch
			assert.strictEqual(tree.getContent(), 'v3');
			// v1's children should include both v2 and v3
		});
	});

	suite('Head Navigation', () => {
		test('setHead checks out arbitrary node', () => {
			const tree = new CtrlZTree('v1');
			const v2 = tree.set('v2');
			tree.set('v3');
			tree.setHead(v2);
			assert.strictEqual(tree.getContent(), 'v2');
			assert.strictEqual(tree.getHead(), v2);
		});

		test('setHead on nonexistent hash returns false', () => {
			const tree = new CtrlZTree('v1');
			assert.strictEqual(tree.setHead('nonexistent'), false);
		});

		test('peekUndo does not move head', () => {
			const tree = new CtrlZTree('v1');
			const v2 = tree.set('v2');
			tree.set('v3');
			const headBefore = tree.getHead();
			const peeked = tree.peekUndo();
			assert.strictEqual(peeked, v2);
			assert.strictEqual(tree.getHead(), headBefore);
		});

		test('peekRedoChildren does not move head', () => {
			const tree = new CtrlZTree('v1');
			const v2 = tree.set('v2');
			tree.z(); // undo
			const headBefore = tree.getHead();
			const children = tree.peekRedoChildren();
			assert.strictEqual(children.length, 1);
			assert.strictEqual(children[0], v2);
			assert.strictEqual(tree.getHead(), headBefore);
		});
	});

	suite('Tree Structure', () => {
		test('root node has no parent', () => {
			const tree = new CtrlZTree('content');
			const rootHash = tree.getInternalRootHash();
			const parent = tree.getAllNodes().get(rootHash)?.parent;
			assert.strictEqual(parent, null);
		});

		test('all nodes are accessible', () => {
			const tree = new CtrlZTree('v1');
			tree.set('v2');
			tree.set('v3');
			const allNodes = tree.getAllNodes();
			assert.ok(allNodes.size >= 4); // empty root + initial + v2 + v3
		});

		test('head path is consistent', () => {
			const tree = new CtrlZTree('v1');
			tree.set('v2');
			tree.set('v3');
			const head = tree.getHead();
			assert.ok(head);
			// Verifying content reconstruction works
			assert.strictEqual(tree.getContent(head!), 'v3');
		});

		test('node count tracks correctly', () => {
			const tree = new CtrlZTree('v1');
			const count1 = tree.getNodeCount();
			tree.set('v2');
			assert.ok(tree.getNodeCount() >= count1 + 1);
		});
	});

	suite('Pruning', () => {
		test('pruneToMaxNodes removes non-head-path nodes', () => {
			const tree = new CtrlZTree('v1');
			// Create many branches off root
			for (let i = 0; i < 30; i++) {
				tree.set(`branch ${i}`);
				tree.z(); // undo back to root each time
			}
			tree.set('final'); // last head
			const countBefore = tree.getNodeCount();
			tree.pruneToMaxNodes(10);
			assert.ok(tree.getNodeCount() <= 10);
		});

		test('head path is preserved during pruning', () => {
			const tree = new CtrlZTree('v1');
			const head = tree.getHead();
			tree.pruneToMaxNodes(1);
			assert.strictEqual(tree.getHead(), head);
			assert.ok(tree.getAllNodes().has(head!));
		});
	});

	suite('Edge Cases', () => {
		test('unicode content preserved through edits', () => {
			const tree = new CtrlZTree('你好');
			tree.set('你好世界');
			assert.strictEqual(tree.getContent(), '你好世界');
		});

		test('multiline content preserved', () => {
			const tree = new CtrlZTree('line1\nline2');
			tree.set('line1\nline2\nline3');
			assert.strictEqual(tree.getContent(), 'line1\nline2\nline3');
		});

		test('special characters preserved', () => {
			const tree = new CtrlZTree('{ "key": "value" }');
			tree.set('{ "key": "new" }');
			assert.strictEqual(tree.getContent(), '{ "key": "new" }');
		});
	});
});
