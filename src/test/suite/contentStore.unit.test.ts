import * as assert from 'assert';
import { MemoryContentStore, DEFAULT_SNAPSHOT_POLICY } from '../../history/contentStore';
import { Projection } from '../../history/projection';
import { SnapshotPolicy } from '../../history/contentStore';

suite('MemoryContentStore', () => {
	function makeSimpleProjection(nodeIds: number[], rootId = 0, headId?: number): Projection {
		const byId = new Map<number, any>();
		const parentOf = new Map<number, number | null>();
		const childrenOf = new Map<number, number[]>();

		byId.set(rootId, { nodeId: rootId, contentHash: 'hash-0', protected: false, createdAt: 0 });
		parentOf.set(rootId, null);
		childrenOf.set(rootId, []);

		let prev = rootId;
		for (let i = 1; i < nodeIds.length; i++) {
			const id = nodeIds[i];
			byId.set(id, { nodeId: id, contentHash: `hash-${id}`, protected: false, createdAt: i * 100 });
			parentOf.set(id, prev);
			const children = childrenOf.get(prev) ?? [];
			children.push(id);
			childrenOf.set(prev, children);
			// Ensure next parent has children list
			childrenOf.set(id, []);
			prev = id;
		}

		return {
			docId: 'doc1',
			rootId,
			headId: headId ?? (nodeIds.length > 0 ? nodeIds[nodeIds.length - 1] : rootId),
			byId,
			parentOf,
			childrenOf,
			branchTips: [headId ?? rootId],
			namedNodes: [],
			protectedNodes: new Set(),
			archivedNodes: new Set(),
			deletedNodes: new Set(),
			contentHashIndex: new Map(),
			lastSeq: nodeIds.length - 1,
			stats: { nodeCount: nodeIds.length, branchCount: 1, archivedCount: 0, deletedCount: 0 },
			diagnostics: []
		};
	}

	test('appendEdit with inline-diff returns inline-diff ref for small content', () => {
		const store = new MemoryContentStore();
		const policy: SnapshotPolicy = { ...DEFAULT_SNAPSHOT_POLICY, snapshotEveryNodes: 999 };
		const ref = store.appendEdit('abc', 'abcd', 1, policy);
		assert.strictEqual(ref.kind, 'inline-diff');
	});

	test('appendEdit with snapshot returns snapshot ref when content exceeds threshold', () => {
		const store = new MemoryContentStore();
		const largeContent = 'x'.repeat(10000);
		const policy: SnapshotPolicy = { ...DEFAULT_SNAPSHOT_POLICY, snapshotEveryNodes: 999, snapshotInlineThresholdBytes: 100 };
		const ref = store.appendEdit('abc', largeContent, 1, policy);
		assert.strictEqual(ref.kind, 'snapshot');
	});

	test('appendEdit with snapshotEveryNodes creates snapshot at interval', () => {
		const store = new MemoryContentStore();
		const policy: SnapshotPolicy = { ...DEFAULT_SNAPSHOT_POLICY, snapshotEveryNodes: 3 };
		store.appendEdit('a', 'ab', 1, policy);
		store.appendEdit('ab', 'abc', 2, policy);
		const ref = store.appendEdit('abc', 'abcd', 3, policy);
		assert.strictEqual(ref.kind, 'snapshot');
	});

	test('resolve returns correct content for linear chain', () => {
		const store = new MemoryContentStore();
		const policy: SnapshotPolicy = { ...DEFAULT_SNAPSHOT_POLICY, snapshotEveryNodes: 1 }; // snapshot root
		store.appendEdit('', 'init', 0, policy);

		const proj = makeSimpleProjection([0]);
		const content = store.resolve(0, proj);
		assert.strictEqual(content, 'init');
	});

	test('resolve follows diffs through chain', () => {
		const store = new MemoryContentStore();
		const policy: SnapshotPolicy = { ...DEFAULT_SNAPSHOT_POLICY, snapshotEveryNodes: 1 };

		store.appendEdit('', 'v1', 0, policy);
		const proj = makeSimpleProjection([0, 1]);

		store.appendEdit('v1', 'v1 + edit', 1, policy);

		const content = store.resolve(1, proj);
		assert.strictEqual(content, 'v1 + edit');
	});

	test('resolve returns null for missing node', () => {
		const store = new MemoryContentStore();
		const proj = makeSimpleProjection([]);
		assert.strictEqual(store.resolve(999, proj), null);
	});

	test('tryResolve returns ok for resolvable node', () => {
		const store = new MemoryContentStore();
		const policy: SnapshotPolicy = { ...DEFAULT_SNAPSHOT_POLICY, snapshotEveryNodes: 1 };
		store.appendEdit('', 'data', 0, policy);
		const proj = makeSimpleProjection([0]);
		const result = store.tryResolve(0, proj);
		assert.strictEqual(result.ok, true);
		assert.strictEqual((result as any).content, 'data');
	});

	test('tryResolve returns error for unresolvable node', () => {
		const store = new MemoryContentStore();
		const proj = makeSimpleProjection([]);
		const result = store.tryResolve(999, proj);
		assert.strictEqual(result.ok, false);
	});

	test('cache returns same content without re-evaluating', () => {
		const store = new MemoryContentStore();
		const policy: SnapshotPolicy = { ...DEFAULT_SNAPSHOT_POLICY, snapshotEveryNodes: 1 };
		store.appendEdit('', 'data', 0, policy);
		const proj = makeSimpleProjection([0]);
		const c1 = store.resolve(0, proj);
		const c2 = store.resolve(0, proj);
		assert.strictEqual(c1, c2);
		assert.strictEqual(c1, 'data');
	});

	test('hasSnapshot returns true for snapshot entries', () => {
		const store = new MemoryContentStore();
		const largeContent = 'x'.repeat(10000);
		const policy: SnapshotPolicy = { ...DEFAULT_SNAPSHOT_POLICY, snapshotInlineThresholdBytes: 100 };
		store.appendEdit('', largeContent, 1, policy);
		assert.strictEqual(store.hasSnapshot(1), true);
	});

	test('hasSnapshot returns false for inline-diff entries', () => {
		const store = new MemoryContentStore();
		const policy: SnapshotPolicy = { ...DEFAULT_SNAPSHOT_POLICY, snapshotEveryNodes: 999 };
		store.appendEdit('a', 'ab', 1, policy);
		assert.strictEqual(store.hasSnapshot(1), false);
	});

	test('clearCacheFor removes cache entry', () => {
		const store = new MemoryContentStore();
		const policy: SnapshotPolicy = { ...DEFAULT_SNAPSHOT_POLICY, snapshotEveryNodes: 1 };
		store.appendEdit('', 'data', 0, policy);
		const proj = makeSimpleProjection([0]);
		store.resolve(0, proj);
		assert.strictEqual(store.getCacheSize() > 0, true);
		store.clearCacheFor(0);
		assert.strictEqual(store.getCacheSize(), 0);
	});

	test('unicode content round-tripped correctly', () => {
		const store = new MemoryContentStore();
		const policy: SnapshotPolicy = { ...DEFAULT_SNAPSHOT_POLICY, snapshotEveryNodes: 1 };
		store.appendEdit('', '你好世界 🌍', 0, policy);
		const proj = makeSimpleProjection([0]);
		const content = store.resolve(0, proj);
		assert.strictEqual(content, '你好世界 🌍');
	});

	test('getEntryCount returns correct number', () => {
		const store = new MemoryContentStore();
		const policy = DEFAULT_SNAPSHOT_POLICY;
		store.appendEdit('a', 'ab', 1, policy);
		store.appendEdit('ab', 'abc', 2, policy);
		assert.strictEqual(store.getEntryCount(), 2);
	});

	test('LRU eviction limits cache size', () => {
		const store = new MemoryContentStore(2);
		const policy: SnapshotPolicy = { ...DEFAULT_SNAPSHOT_POLICY, snapshotEveryNodes: 1 };
		for (let i = 0; i < 5; i++) {
			store.appendEdit('', `content-${i}`, i, policy);
		}
		const proj = makeSimpleProjection([0, 1, 2, 3, 4]);
		store.resolve(0, proj);
		store.resolve(1, proj);
		store.resolve(3, proj);
		const cacheSize = store.getCacheSize();
		assert.ok(cacheSize > 0);
	});
});
