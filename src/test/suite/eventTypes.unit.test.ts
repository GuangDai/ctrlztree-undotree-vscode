import * as assert from 'assert';
import { HistoryEvent, InitEvent, EditEvent, HeadMoveEvent } from '../../history/events';

suite('History Event Types', () => {
	test('InitEvent has correct shape', () => {
		const init: InitEvent = {
			kind: 'init',
			schemaVersion: 1,
			seq: 0,
			at: Date.now(),
			txId: 'tx-1',
			source: 'system',
			nodeId: 0,
			contentRef: { kind: 'snapshot', bytes: 0 },
			contentHash: 'sha256...',
			isNonEmpty: false,
			fileSig: { mtime: 0, size: 0 }
		};
		assert.strictEqual(init.kind, 'init');
		assert.strictEqual(init.nodeId, 0);
	});

	test('EditEvent has correct shape', () => {
		const edit: EditEvent = {
			kind: 'edit',
			schemaVersion: 1,
			seq: 1,
			at: Date.now(),
			txId: 'tx-2',
			source: 'user',
			nodeId: 1,
			parentId: 0,
			contentRef: { kind: 'inline-diff', nodeId: 1, bytes: 42 },
			contentHash: 'sha256...',
			cursor: { line: 0, character: 5 },
			isNonEmpty: true,
			stats: { contentBytes: 100, diffBytes: 10, lineCount: 5 }
		};
		assert.strictEqual(edit.kind, 'edit');
		assert.strictEqual(edit.parentId, 0);
		assert.strictEqual(edit.stats.diffBytes, 10);
	});

	test('HeadMoveEvent has correct shape', () => {
		const move: HeadMoveEvent = {
			kind: 'headMove',
			schemaVersion: 1,
			seq: 2,
			at: Date.now(),
			txId: 'tx-3',
			source: 'user',
			from: 1,
			to: 0,
			reason: 'undo'
		};
		assert.strictEqual(move.kind, 'headMove');
		assert.strictEqual(move.reason, 'undo');
	});

	test('union type HistoryEvent accepts all event kinds', () => {
		const events: HistoryEvent[] = [
			{
				kind: 'init',
				schemaVersion: 1, seq: 0, at: 0, txId: 'a', source: 'system',
				nodeId: 0, contentRef: { kind: 'snapshot', bytes: 0 },
				contentHash: '', isNonEmpty: false, fileSig: { mtime: 0, size: 0 }
			},
			{
				kind: 'edit',
				schemaVersion: 1, seq: 1, at: 0, txId: 'b', source: 'user',
				nodeId: 1, parentId: 0, contentRef: { kind: 'inline-diff', bytes: 0 },
				contentHash: '', isNonEmpty: true,
				stats: { contentBytes: 0, diffBytes: 0, lineCount: 1 },
			},
			{
				kind: 'headMove',
				schemaVersion: 1, seq: 2, at: 0, txId: 'c', source: 'user',
				from: 0, to: 1, reason: 'checkout'
			}
		];
		assert.strictEqual(events.length, 3);
	});

	test('source field accepts valid values', () => {
		const validSources: Array<HistoryEvent['source']> = ['user', 'system', 'ai-plan', 'migration'];
		assert.strictEqual(validSources.length, 4);
	});

	test('ContentRef kinds are correct', () => {
		const refs = [
			{ kind: 'inline-diff' as const, bytes: 1 },
			{ kind: 'snapshot' as const, bytes: 2 },
			{ kind: 'external' as const, bytes: 3 },
		];
		assert.strictEqual(refs[0].kind, 'inline-diff');
		assert.strictEqual(refs[1].kind, 'snapshot');
		assert.strictEqual(refs[2].kind, 'external');
	});

	test('Cursor type supports positions', () => {
		const cursor = { line: 5, character: 10 };
		assert.strictEqual(cursor.line, 5);
		assert.strictEqual(cursor.character, 10);
	});
});
