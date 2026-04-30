import * as assert from 'assert';
import { project, Projection } from '../../history/projection';
import { HistoryEvent } from '../../history/events';

suite('Projection', () => {
	function makeInit(nodeId = 0, contentHash = 'hash-0', isNonEmpty = false): HistoryEvent {
		return {
			kind: 'init', schemaVersion: 1, seq: 0, at: 1000, txId: 'tx-0', source: 'system',
			nodeId, contentRef: { kind: 'snapshot', bytes: 0 }, contentHash, isNonEmpty,
			fileSig: { mtime: 1000, size: 0 }
		};
	}

	function makeEdit(nodeId: number, parentId: number, seq: number, contentHash?: string): HistoryEvent {
		return {
			kind: 'edit', schemaVersion: 1, seq, at: 1000 + seq * 100, txId: `tx-${seq}`, source: 'user',
			nodeId, parentId, contentHash: contentHash ?? `hash-${nodeId}`,
			contentRef: { kind: 'inline-diff', nodeId, bytes: 10 }, isNonEmpty: true,
			stats: { contentBytes: 100, diffBytes: 10, lineCount: 5 }
		};
	}

	function makeHeadMove(from: number, to: number, seq: number, reason: 'undo' | 'redo' | 'checkout' = 'undo'): HistoryEvent {
		return {
			kind: 'headMove', schemaVersion: 1, seq, at: 1000 + seq * 100, txId: `tx-${seq}`, source: 'user',
			from, to, reason
		};
	}

	test('empty events returns empty projection', () => {
		const p = project('doc1', []);
		assert.strictEqual(p.docId, 'doc1');
		assert.strictEqual(p.byId.size, 0);
		assert.strictEqual(p.lastSeq, -1);
	});

	test('init event sets root and head', () => {
		const events: HistoryEvent[] = [makeInit(0)];
		const p = project('doc1', events);
		assert.strictEqual(p.rootId, 0);
		assert.strictEqual(p.headId, 0);
		assert.strictEqual(p.byId.size, 1);
		assert.strictEqual(p.parentOf.get(0), null);
	});

	test('edit event creates child and sets head', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1)
		];
		const p = project('doc1', events);
		assert.strictEqual(p.headId, 1);
		assert.strictEqual(p.parentOf.get(1), 0);
		const children = p.childrenOf.get(0) ?? [];
		assert.ok(children.includes(1));
	});

	test('headMove changes head', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			makeEdit(2, 1, 2),
			makeHeadMove(2, 1, 3, 'undo')
		];
		const p = project('doc1', events);
		assert.strictEqual(p.headId, 1);
	});

	test('headMove to nonexistent node generates error diagnostic', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeHeadMove(0, 99, 1, 'checkout')
		];
		const p = project('doc1', events);
		assert.strictEqual(p.diagnostics.length, 1);
		assert.strictEqual(p.diagnostics[0].severity, 'error');
		assert.ok(p.diagnostics[0].message.includes('nonexistent'));
	});

	test('headMove to deleted node generates error diagnostic', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			{ kind: 'delete', schemaVersion: 1, seq: 2, at: 2000, txId: 'tx-2', source: 'user', nodeIds: [1], mode: 'hard', reason: 'test' },
			makeHeadMove(0, 1, 3)
		];
		const p = project('doc1', events);
		const headErrors = p.diagnostics.filter(d => d.message.includes('HeadMove'));
		assert.ok(headErrors.length >= 1);
	});

	test('archive adds nodes to archived set', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			{ kind: 'archive', schemaVersion: 1, seq: 2, at: 2000, txId: 'tx-2', source: 'user', nodeIds: [1], reason: 'test' }
		];
		const p = project('doc1', events);
		assert.strictEqual(p.archivedNodes.has(1), true);
	});

	test('hard delete adds nodes to deleted set', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			{ kind: 'delete', schemaVersion: 1, seq: 2, at: 2000, txId: 'tx-2', source: 'user', nodeIds: [1], mode: 'hard', reason: 'test' }
		];
		const p = project('doc1', events);
		assert.strictEqual(p.deletedNodes.has(1), true);
	});

	test('soft delete adds to archived, not deleted', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			{ kind: 'delete', schemaVersion: 1, seq: 2, at: 2000, txId: 'tx-2', source: 'user', nodeIds: [1], mode: 'soft', reason: 'test' }
		];
		const p = project('doc1', events);
		assert.strictEqual(p.deletedNodes.has(1), false);
		assert.strictEqual(p.archivedNodes.has(1), true);
	});

	test('contentHashIndex tracks content references', () => {
		const events: HistoryEvent[] = [
			makeInit(0, 'hash-a'),
			makeEdit(1, 0, 1, 'hash-b'),
			makeEdit(2, 1, 2, 'hash-b')  // same content
		];
		const p = project('doc1', events);
		const refs = p.contentHashIndex.get('hash-b') ?? [];
		assert.strictEqual(refs.length, 2);
		assert.ok(refs.includes(1));
		assert.ok(refs.includes(2));
	});

	test('protect event marks nodes as protected', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			{ kind: 'protect', schemaVersion: 1, seq: 2, at: 2000, txId: 'tx-2', source: 'user', nodeId: 1, protected: true, reason: 'important' }
		];
		const p = project('doc1', events);
		assert.strictEqual(p.protectedNodes.has(1), true);
		p.protectedNodes.delete(1);
		// Re-apply unprotect
	});

	test('rename updates node name and adds to namedNodes', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			{ kind: 'rename', schemaVersion: 1, seq: 2, at: 2000, txId: 'tx-2', source: 'user', nodeId: 1, name: 'Feature X' }
		];
		const p = project('doc1', events);
		assert.ok(p.namedNodes.includes(1));
		assert.strictEqual(p.byId.get(1)?.name, 'Feature X');
	});

	test('branchTips are computed correctly (leaf nodes)', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			makeEdit(2, 1, 2),
			// Move head back to create branch
			makeHeadMove(2, 1, 3, 'undo'),
			makeEdit(3, 1, 4),  // new branch from 1
		];
		const p = project('doc1', events);
		// 2 and 3 are branch tips (leaf nodes)
		assert.ok(p.branchTips.length >= 2);
	});

	test('stats are correctly computed', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			makeEdit(2, 1, 2),
			{ kind: 'archive', schemaVersion: 1, seq: 3, at: 2000, txId: 'tx-3', source: 'user', nodeIds: [2], reason: 'test' }
		];
		const p = project('doc1', events);
		assert.strictEqual(p.stats.nodeCount, 3);
		assert.strictEqual(p.stats.archivedCount, 1);
		assert.strictEqual(p.stats.deletedCount, 0);
	});

	test('invariant: root has no parent', () => {
		const p = project('doc1', [makeInit(0)]);
		assert.strictEqual(p.parentOf.get(0), null);
		const errors = p.diagnostics.filter(d => d.message.includes('Root'));
		assert.strictEqual(errors.length, 0);
	});

	test('invariant: every visible non-root node has a parent', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			makeEdit(2, 1, 2)
		];
		const p = project('doc1', events);
		const parentErrors = p.diagnostics.filter(d => d.message.includes('has no parent'));
		assert.strictEqual(parentErrors.length, 0);
	});

	test('invariant: head exists and is not hard deleted', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			{ kind: 'delete', schemaVersion: 1, seq: 2, at: 2000, txId: 'tx-2', source: 'user', nodeIds: [1], mode: 'hard', reason: 'test' }
		];
		const p = project('doc1', events);
		const headErrors = p.diagnostics.filter(d => d.message.includes('Head'));
		assert.ok(headErrors.length >= 1);
	});

	test('childrenOf and parentOf consistency (no cross-parent)', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			makeEdit(2, 1, 2)
		];
		const p = project('doc1', events);
		const consistencyErrors = p.diagnostics.filter(d => d.message.includes('Consistency'));
		assert.strictEqual(consistencyErrors.length, 0);
	});

	test('merge event archives sources and creates result', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			makeEdit(2, 1, 2),
			{
				kind: 'merge', schemaVersion: 1, seq: 3, at: 3000, txId: 'tx-3', source: 'user',
				sourceIds: [1, 2], resultId: 3, parentId: 0,
				contentRef: { kind: 'inline-diff', bytes: 10 }, contentHash: 'hash-3',
				archivedSourceIds: [], reason: 'squash'
			}
		];
		const p = project('doc1', events);
		assert.strictEqual(p.archivedNodes.has(1), true);
		assert.strictEqual(p.archivedNodes.has(2), true);
		assert.strictEqual(p.byId.has(3), true);
		assert.strictEqual(p.parentOf.get(3), 0);
	});

	test('prune event archives and hard-deletes nodes', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			{
				kind: 'prune', schemaVersion: 1, seq: 2, at: 2000, txId: 'tx-2', source: 'system',
				strategy: 'preserve-head', archivedIds: [1], deletedIds: [], estimatedBytesFreed: 100, warnings: []
			}
		];
		const p = project('doc1', events);
		assert.strictEqual(p.archivedNodes.has(1), true);
	});

	test('summarize event stores summary on node', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			{
				kind: 'summarize', schemaVersion: 1, seq: 2, at: 2000, txId: 'tx-2', source: 'ai-plan',
				nodeId: 1, summary: 'Added feature X'
			}
		];
		const p = project('doc1', events);
		assert.strictEqual(p.byId.get(1)?.summary, 'Added feature X');
	});

	test('reset event clears all state and creates new root', () => {
		const events: HistoryEvent[] = [
			makeInit(0),
			makeEdit(1, 0, 1),
			makeEdit(2, 1, 2),
			{
				kind: 'reset', schemaVersion: 1, seq: 3, at: 3000, txId: 'tx-3', source: 'user',
				previousHeadId: 2, newRootId: 10, reason: 'fresh start'
			}
		];
		const p = project('doc1', events);
		assert.strictEqual(p.rootId, 10);
		assert.strictEqual(p.headId, 10);
		assert.strictEqual(p.byId.size, 1);
		assert.strictEqual(p.parentOf.get(10), null);
	});
});
