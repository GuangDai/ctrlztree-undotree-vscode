import * as assert from 'assert';
import { PersistenceService } from '../../security/persistenceService';
import { HistoryEvent } from '../../history/events';

suite('PersistenceService', () => {
	suite('computeFingerprint', () => {
		test('returns 24-character hex string', () => {
			const fp = PersistenceService.computeFingerprint('file:///test/file.ts');
			assert.strictEqual(typeof fp, 'string');
			assert.strictEqual(fp.length, 24);
			assert.ok(/^[a-f0-9]{24}$/.test(fp));
		});

		test('different URIs produce different fingerprints', () => {
			const fp1 = PersistenceService.computeFingerprint('file:///test/a.ts');
			const fp2 = PersistenceService.computeFingerprint('file:///test/b.ts');
			assert.notStrictEqual(fp1, fp2);
		});

		test('same URI produces same fingerprint', () => {
			const fp1 = PersistenceService.computeFingerprint('file:///test/same.ts');
			const fp2 = PersistenceService.computeFingerprint('file:///test/same.ts');
			assert.strictEqual(fp1, fp2);
		});

		test('fingerprint does not directly expose path', () => {
			const fp = PersistenceService.computeFingerprint('file:///home/user/secret_project/main.ts');
			assert.ok(!fp.includes('secret_project'));
			assert.ok(!fp.includes('home'));
			assert.ok(!fp.includes('user'));
		});
	});

	suite('Event Integrity', () => {
		test('events are JSON-serializable round-trip', () => {
			const event: HistoryEvent = {
				kind: 'init',
				schemaVersion: 1,
				seq: 0,
				at: 1234567890000,
				txId: 'tx-0',
				source: 'system',
				nodeId: 0,
				contentRef: { kind: 'snapshot', bytes: 0 },
				contentHash: 'abc123',
				isNonEmpty: false,
				fileSig: { mtime: 0, size: 0 },
			};
			const json = JSON.stringify(event);
			const parsed = JSON.parse(json);
			assert.strictEqual(parsed.kind, 'init');
			assert.strictEqual(parsed.nodeId, 0);
			assert.strictEqual(parsed.contentHash, 'abc123');
		});

		test('edit event round-trip preserves all fields', () => {
			const event = {
				kind: 'edit',
				schemaVersion: 1,
				seq: 1,
				at: 1234567890000,
				txId: 'tx-1',
				source: 'user',
				nodeId: 1,
				parentId: 0,
				contentRef: { kind: 'inline-diff', nodeId: 1, bytes: 100 },
				contentHash: 'def456',
				isNonEmpty: true,
				cursor: { line: 5, character: 10 },
				stats: { contentBytes: 200, diffBytes: 100, lineCount: 15 },
			} as HistoryEvent;
			const json = JSON.stringify(event);
			const parsed = JSON.parse(json) as Record<string, unknown>;
			assert.strictEqual(parsed.kind, 'edit');
			assert.strictEqual(parsed.nodeId, 1);
			assert.strictEqual(parsed.parentId, 0);
			assert.strictEqual(parsed.contentHash, 'def456');
			const stats = parsed.stats as Record<string, unknown> | undefined;
			assert.ok(stats);
			assert.strictEqual(stats!.lineCount, 15);
		});

		test('headMove event round-trip preserves reason', () => {
			const event: HistoryEvent = {
				kind: 'headMove',
				schemaVersion: 1,
				seq: 2,
				at: 1234567890000,
				txId: 'tx-2',
				source: 'user',
				from: 0,
				to: 1,
				reason: 'undo',
			};
			const json = JSON.stringify(event);
			const parsed = JSON.parse(json) as HistoryEvent;
			assert.strictEqual(parsed.kind, 'headMove');
			if (parsed.kind === 'headMove') {
				assert.strictEqual(parsed.reason, 'undo');
				assert.strictEqual(parsed.from, 0);
				assert.strictEqual(parsed.to, 1);
			}
		});

		test('fingerprint is deterministic across calls', () => {
			const uri = 'file:///test/consistent.ts';
			const fp1 = PersistenceService.computeFingerprint(uri);
			const fp2 = PersistenceService.computeFingerprint(uri);
			assert.strictEqual(fp1, fp2, 'Fingerprint should be deterministic');
			assert.ok(fp1.length > 0, 'Fingerprint should not be empty');
		});

		test('event with extra fields still parses', () => {
			const event = {
				kind: 'init',
				schemaVersion: 1,
				seq: 0,
				at: 1234567890000,
				txId: 'tx-0',
				source: 'system',
				nodeId: 0,
				contentRef: { kind: 'snapshot', bytes: 0 },
				contentHash: 'abc123',
				isNonEmpty: false,
				fileSig: { mtime: 0, size: 0 },
				extraField: 'should be ignored',
			};
			const json = JSON.stringify(event);
			const parsed = JSON.parse(json);
			assert.strictEqual(parsed.kind, 'init');
			assert.strictEqual(parsed.extraField, 'should be ignored');
		});
	});
});
