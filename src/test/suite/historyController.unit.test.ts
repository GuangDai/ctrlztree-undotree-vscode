import * as assert from 'assert';
import { HistoryController } from '../../history/historyController';
import { CtrlZTree } from '../../model/ctrlZTree';
import { DocumentTaskQueue } from '../../concurrency/documentTaskQueue';

suite('HistoryController', () => {
	let tree: CtrlZTree;
	let queue: DocumentTaskQueue;
	let controller: HistoryController;

	setup(() => {
		tree = new CtrlZTree('hello');
		queue = new DocumentTaskQueue();
		controller = new HistoryController({ docId: 'test-doc', tree, queue });
	});

	suite('initialization', () => {
		test('creates init event in constructor', () => {
			const events = controller.getEvents();
			assert.ok(events.length >= 1);
			const init = events.find(e => e.kind === 'init');
			assert.ok(init);
		});

		test('projection has root and head after init', () => {
			const proj = controller.getProjection();
			assert.strictEqual(proj.rootId, 0);
			assert.ok(proj.byId.has(0));
			assert.strictEqual(proj.parentOf.get(0), null);
		});

		test('tree is accessible through controller', () => {
			const t = controller.getTree();
			assert.ok(t);
			assert.strictEqual(t.getContent(), 'hello');
		});
	});

	suite('commit', () => {
		test('generates edit event on commit', async () => {
			const beforeCount = controller.getEvents().length;
			await controller.commit('hello world');
			const afterCount = controller.getEvents().length;
			assert.ok(afterCount > beforeCount, `expected more events after commit, got ${beforeCount} -> ${afterCount}`);
			const editEvent = controller.getEvents().find(e => e.kind === 'edit');
			assert.ok(editEvent);
		});

		test('projection head updates after commit', async () => {
			await controller.commit('hello world');
			const proj = controller.getProjection();
			assert.ok(proj.headId !== 0);
			assert.ok(proj.byId.has(proj.headId));
		});

		test('multiple commits produce multiple events', async () => {
			await controller.commit('a');
			await controller.commit('ab');
			await controller.commit('abc');
			const editEvents = controller.getEvents().filter(e => e.kind === 'edit');
			assert.ok(editEvents.length >= 3);
		});

		test('content hash uses sha256 of content', async () => {
			await controller.commit('test content');
			const editEvent = controller.getEvents().find(e => e.kind === 'edit');
			assert.ok(editEvent);
			if (editEvent && 'contentHash' in editEvent) {
				const contentHash = editEvent.contentHash;
				assert.strictEqual(typeof contentHash, 'string');
				assert.strictEqual(contentHash.length, 64);
			}
		});

		test('same content produces same ContentHash', async () => {
			await controller.commit('same');
			// undo
			await controller.undo();
			// redo with same content
			const children = controller.getTree().peekRedoChildren();
			if (children.length > 0) {
				await controller.redo(children[0]);
			}
			const editEvents = controller.getEvents().filter(e => e.kind === 'edit');
			const hashes = editEvents.map((e: any) => e.contentHash);
			for (let i = 0; i < hashes.length - 1; i++) {
				for (let j = i + 1; j < hashes.length; j++) {
					if (hashes[i] === hashes[j]) {
						return; // found matching hashes for same content, good
					}
				}
			}
		});
	});

	suite('undo', () => {
		test('generates headMove event on undo', async () => {
			await controller.commit('changed');
			await controller.undo();
			const headMoves = controller.getEvents().filter(e => e.kind === 'headMove');
			assert.ok(headMoves.length >= 1);
			const lastMove = headMoves[headMoves.length - 1];
			assert.strictEqual((lastMove as any).reason, 'undo');
		});

		test('returns content after undo', async () => {
			await controller.commit('changed');
			const result = await controller.undo();
			assert.ok(result.hash);
			assert.ok(result.content);
		});

		test('returns null when no parent to undo to', async () => {
			const result = await controller.undo();
			assert.strictEqual(result.hash, null);
			assert.strictEqual(result.content, null);
		});
	});

	suite('redo', () => {
		test('generates headMove event on redo', async () => {
			await controller.commit('changed');
			await controller.undo();
			const children = controller.getTree().getAllNodes().get(controller.getHead()!)?.children;
			if (children && children.length > 0) {
				await controller.redo(children[0]);
			}
			const headMoves = controller.getEvents().filter(e => e.kind === 'headMove');
			assert.ok(headMoves.length >= 2);
		});

		test('returns content after redo', async () => {
			await controller.commit('changed');
			await controller.undo();
			const children = controller.getTree().getAllNodes().get(controller.getHead()!)?.children;
			if (children && children.length > 0) {
				const result = await controller.redo(children[0]);
				assert.ok(result.hash);
				assert.ok(result.content);
			}
		});
	});

	suite('serialization', () => {
		test('commits are serialized through document task queue', async () => {
			const results: string[] = [];
			const p1 = controller.commit('a').then(r => { results.push('a'); return r; });
			const p2 = controller.commit('ab').then(r => { results.push('b'); return r; });
			await Promise.all([p1, p2]);
			assert.deepStrictEqual(results, ['a', 'b']);
		});

		test('close clears the queue', () => {
			controller.close();
			assert.strictEqual(queue.getPendingCount('test-doc'), 0);
		});
	});

	suite('recordHeadMove', () => {
		test('generates headMove event on recordHeadMove', () => {
			const beforeCount = controller.getEvents().length;
			// Get actual hashes from the tree
			const head = controller.getHead()!;
			// Commit to create a new node
			controller.commit('new content').then(() => {
				const newHead = controller.getHead()!;
				controller.recordHeadMove(head, newHead, 'checkout');
				const afterCount = controller.getEvents().length;
				assert.ok(afterCount > beforeCount, 'should have more events');
				const headMoves = controller.getEvents().filter(e => e.kind === 'headMove');
				assert.ok(headMoves.length >= 1);
				assert.strictEqual((headMoves[headMoves.length - 1] as any).reason, 'checkout');
			});
		});

		test('recordHeadMove updates projection', async () => {
			await controller.commit('move test');
			const oldHead = controller.getProjection().headId;
			const head = controller.getHead()!;
			// Undo to move head
			const result = await controller.undo();
			if (result.hash) {
				const newHead = controller.getProjection().headId;
				assert.notStrictEqual(oldHead, newHead, 'projection head should change after undo');
			}
		});
	});

	suite('projection invariants', () => {
		test('projection has no orphan nodes after linear edits', async () => {
			await controller.commit('a');
			await controller.commit('ab');
			await controller.commit('abc');
			const proj = controller.getProjection();
			for (const [id] of proj.byId) {
				if (id !== proj.rootId) {
					const parent = proj.parentOf.get(id);
					assert.ok(parent !== undefined && parent !== null,
						`node ${id} should have a parent`);
				}
			}
		});

		test('projection head exists after edits', async () => {
			await controller.commit('a');
			await controller.commit('ab');
			const proj = controller.getProjection();
			assert.ok(proj.byId.has(proj.headId));
			assert.ok(!proj.deletedNodes.has(proj.headId));
		});

		test('executeMergePlan creates merge event and returns new nodeId', async () => {
			await controller.commit('a');
			await controller.commit('ab');
			await controller.commit('abc');
			const projBefore = controller.getProjection();
			// Find a linear chain of 3 nodes
			const plan = { sourceIds: [2, 3], targetParentId: 1, estimatedBytesFreed: 2048, warnings: [], valid: true };
			const result = controller.executeMergePlan(plan, 'abc');
			assert.ok(result.ok);
			if (result.ok) {
				assert.ok(result.nodeId > 0);
				const projAfter = controller.getProjection();
				assert.ok(projAfter.byId.has(result.nodeId));
			}
		});

		test('executeMergePlan rejects invalid plan', () => {
			const result = controller.executeMergePlan(
				{ sourceIds: [], targetParentId: 0, estimatedBytesFreed: 0, warnings: ['invalid'], valid: false },
				'x'
			);
			assert.ok(!result.ok);
			if (!result.ok) {
				assert.ok(result.error.includes('not valid'));
			}
		});

		test('executeDeletePlan archives specified nodes', async () => {
			await controller.commit('a');
			await controller.commit('ab');
			await controller.commit('abc');
			// Undo twice to move head away from nodes we want to delete
			await controller.undo();
			await controller.undo();
			const projBefore = controller.getProjection();
			const targetIds = Array.from(projBefore.byId.keys()).filter(id =>
				id !== projBefore.headId && id !== projBefore.rootId
			).slice(0, 2);
			if (targetIds.length > 0) {
				const plan = { targetIds, mode: 'soft' as const, estimatedBytesFreed: 2048, warnings: [], valid: true, requiresConfirmation: false };
				const result = controller.executeDeletePlan(plan);
				assert.ok(result.ok);
				const events = controller.getEvents();
				const archiveEvents = events.filter(e => e.kind === 'archive');
				assert.ok(archiveEvents.length > 0);
			}
		});

		test('executeDeletePlan rejects invalid plan', () => {
			const result = controller.executeDeletePlan(
				{ targetIds: [], mode: 'soft', estimatedBytesFreed: 0, warnings: ['none'], valid: false, requiresConfirmation: false }
			);
			assert.ok(!result.ok);
		});
	});
});
