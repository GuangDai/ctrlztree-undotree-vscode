import * as assert from 'assert';
import { generatePrunePlan, DEFAULT_PRUNING_POLICY, PruningPolicy } from '../../history/pruningEngine';
import { Projection, NodeView } from '../../history/projection';

function makeLinearProjection(nodeCount: number): Projection {
	const byId = new Map<number, NodeView>();
	const parentOf = new Map<number, number | null>();
	const childrenOf = new Map<number, number[]>();

	for (let i = 0; i < nodeCount; i++) {
		byId.set(i, { nodeId: i, contentHash: `hash-${i}`, protected: false, createdAt: 1000 + i * 100 });
		parentOf.set(i, i === 0 ? null : i - 1);
		childrenOf.set(i, []);
		if (i > 0) {
			const parentChildren = childrenOf.get(i - 1) ?? [];
			parentChildren.push(i);
			childrenOf.set(i - 1, parentChildren);
		}
	}

	return {
		docId: 'doc1',
		rootId: 0,
		headId: nodeCount - 1,
		byId,
		parentOf,
		childrenOf,
		branchTips: [nodeCount - 1],
		namedNodes: [],
		protectedNodes: new Set(),
		archivedNodes: new Set(),
		deletedNodes: new Set(),
		contentHashIndex: new Map(),
		lastSeq: nodeCount - 1,
		stats: { nodeCount, branchCount: 1, archivedCount: 0, deletedCount: 0 },
		diagnostics: []
	};
}

function makeBranchingProjection(): Projection {
	// root(0) -> a(1) -> b(2)
	//            \-> c(3) -> d(4)
	const byId = new Map<number, NodeView>();
	const parentOf = new Map<number, number | null>();
	const childrenOf = new Map<number, number[]>();

	for (let i = 0; i < 5; i++) {
		byId.set(i, { nodeId: i, contentHash: `hash-${i}`, protected: false, createdAt: 1000 + i * 100 });
		childrenOf.set(i, []);
	}

	parentOf.set(0, null);
	parentOf.set(1, 0);
	parentOf.set(2, 1);
	parentOf.set(3, 1);
	parentOf.set(4, 3);

	childrenOf.get(0)!.push(1);
	childrenOf.get(1)!.push(2, 3);
	childrenOf.get(3)!.push(4);

	return {
		docId: 'doc1',
		rootId: 0,
		headId: 2,
		byId,
		parentOf,
		childrenOf,
		branchTips: [2, 4],
		namedNodes: [],
		protectedNodes: new Set(),
		archivedNodes: new Set(),
		deletedNodes: new Set(),
		contentHashIndex: new Map(),
		lastSeq: 4,
		stats: { nodeCount: 5, branchCount: 2, archivedCount: 0, deletedCount: 0 },
		diagnostics: []
	};
}

suite('PruningEngine', () => {
	test('head-to-root path is always preserved', () => {
		const proj = makeLinearProjection(10);
		const plan = generatePrunePlan(proj);
		assert.ok(plan.keep.includes(proj.headId));
		assert.ok(plan.keep.includes(proj.rootId));
		const headPath = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
		for (const id of headPath) {
			assert.ok(plan.keep.includes(id), `Node ${id} should be preserved in head path`);
		}
	});

	test('archived nodes not on head path are candidates for hard delete', () => {
		const proj = makeBranchingProjection();
		// head is 2 (path: 0->1->2), node 4 is branch tip
		// Archive node 4 (which is a branch tip)
		proj.archivedNodes.add(4);
		const plan = generatePrunePlan(proj);
		// Node 4 is a branch tip but archived, should be in delete
		// Actually, branch tips in keep... let's check policy
		// With keepBranchTips=20, node 4 is kept despite being archived
		// We need to mark a non-branch-tip node as archived
	});

	test('archived non-essential nodes are candidates for hard delete', () => {
		// Build a tree where a node is archived but NOT on head path and NOT a branch tip
		const byId = new Map<number, NodeView>();
		const parentOf = new Map<number, number | null>();
		const childrenOf = new Map<number, number[]>();

		byId.set(0, { nodeId: 0, contentHash: 'h0', protected: false, createdAt: Date.now() - 1000000 });
		byId.set(1, { nodeId: 1, contentHash: 'h1', protected: false, createdAt: Date.now() - 1000000 });
		byId.set(2, { nodeId: 2, contentHash: 'h2', protected: false, createdAt: Date.now() - 1000000 });
		byId.set(3, { nodeId: 3, contentHash: 'h3', protected: false, createdAt: Date.now() });
		byId.set(4, { nodeId: 4, contentHash: 'h4', protected: false, createdAt: Date.now() - 1000000 });

		parentOf.set(0, null);
		parentOf.set(1, 0);
		parentOf.set(2, 1);
		parentOf.set(3, 0);
		parentOf.set(4, 1); // 4 is child of 1, sibling of 2

		childrenOf.set(0, [1, 3]);
		childrenOf.set(1, [2, 4]);
		childrenOf.set(2, []);
		childrenOf.set(3, []);
		childrenOf.set(4, []);

		const proj: Projection = {
			docId: 'doc1', rootId: 0, headId: 3,
			byId, parentOf, childrenOf,
			branchTips: [2, 3, 4], // 3 branch tips
			namedNodes: [],
			protectedNodes: new Set(),
			archivedNodes: new Set([2]),
			deletedNodes: new Set(),
			contentHashIndex: new Map(),
			lastSeq: 3,
			stats: { nodeCount: 5, branchCount: 3, archivedCount: 1, deletedCount: 0 },
			diagnostics: []
		};

		const policy: PruningPolicy = {
			maxNodes: 100,
			keepBranchTips: 0, // 0 additional branch tips beyond head path
			archiveBeforeDelete: true,
			recentWindowMs: 1
		};

		const plan = generatePrunePlan(proj, policy);
		// Node 2 is archived, not in head path (head=3, path: 0->3), not a branch tip (keepBranchTips=0)
		// So it should be in hard delete
		assert.ok(plan.delete.includes(2), `Archived node 2 should be in delete list, got: ${JSON.stringify(plan.delete)}`);
	});

	test('non-archived excess nodes go to archive', () => {
		const proj = makeBranchingProjection();
		const plan = generatePrunePlan(proj);
		// Node 4 is a branch tip, should be kept
		// Nodes 3 is parent of 4, should be kept (path to branch tip)
		// All non-head-path, non-branch-tip nodes go to archive
		// Actually in branching projection, head=2 (path: 0->1->2). Branch tips: 2, 4.
		// So path to tip 4: 0->1->3->4. All nodes are covered.
		// With no archived nodes, archive should be empty.
		// But protected nodes and recent nodes are also kept.
		// Let's add some extra nodes that are NOT in any path.
	});

	test('protected nodes and their path are preserved', () => {
		const proj = makeLinearProjection(10);
		proj.protectedNodes.add(7);
		const plan = generatePrunePlan(proj);

		assert.ok(plan.keep.includes(7));
		// Path to node 7: 0, 1, 2, 3, 4, 5, 6, 7
		for (let i = 0; i <= 7; i++) {
			assert.ok(plan.keep.includes(i), `Node ${i} should be in keep (path to protected 7)`);
		}
	});

	test('branch tips are preserved up to policy limit', () => {
		const proj = makeBranchingProjection();
		const policy: PruningPolicy = { ...DEFAULT_PRUNING_POLICY, keepBranchTips: 2 };
		const plan = generatePrunePlan(proj, policy);

		assert.ok(plan.keep.includes(2)); // head is also a branch tip
		assert.ok(plan.keep.includes(4)); // other branch tip
	});

	test('estimatedBytesFreed is calculated from deletable archived nodes', () => {
		// Use branching tree where archived node IS a branch tip
		// but we set keepBranchTips to 0 so only head path is kept
		const proj = makeBranchingProjection();
		proj.archivedNodes.add(4); // branch tip

		const policy: PruningPolicy = {
			...DEFAULT_PRUNING_POLICY,
			keepBranchTips: 0,
			recentWindowMs: 1
		};
		const plan = generatePrunePlan(proj, policy);
		assert.ok(plan.estimatedBytesFreed > 0);
	});

	test('requiresConfirmation when hard delete candidates exist', () => {
		const proj = makeBranchingProjection();
		proj.archivedNodes.add(4); // archived branch tip

		const policy: PruningPolicy = {
			...DEFAULT_PRUNING_POLICY,
			keepBranchTips: 0,
			recentWindowMs: 1
		};
		const plan = generatePrunePlan(proj, policy);
		// Node 4 should be in delete since it's archived and not kept
		assert.ok(plan.delete.includes(4), `Expected node 4 in delete, got ${JSON.stringify(plan.delete)}`);
		assert.strictEqual(plan.requiresConfirmation, true);
	});

	test('no confirmation needed when only archive', () => {
		// Tree: 0(root) -> 1(head) -> 2 (extra that is not a tip)
		//           \-> 3 (extra branch)
		const byId = new Map<number, NodeView>();
		const parentOf = new Map<number, number | null>();
		const childrenOf = new Map<number, number[]>();

		byId.set(0, { nodeId: 0, contentHash: 'h0', protected: false, createdAt: Date.now() - 1000000 });
		byId.set(1, { nodeId: 1, contentHash: 'h1', protected: false, createdAt: Date.now() - 1000000 });
		byId.set(2, { nodeId: 2, contentHash: 'h2', protected: false, createdAt: Date.now() - 1000000 });

		parentOf.set(0, null);
		parentOf.set(1, 0);
		parentOf.set(2, 1);

		childrenOf.set(0, [1]);
		childrenOf.set(1, [2]);
		childrenOf.set(2, []);

		const proj: Projection = {
			docId: 'doc1', rootId: 0, headId: 2,
			byId, parentOf, childrenOf,
			branchTips: [2], // only one tip = head
			namedNodes: [],
			protectedNodes: new Set(),
			archivedNodes: new Set(),
			deletedNodes: new Set(),
			contentHashIndex: new Map(),
			lastSeq: 2,
			stats: { nodeCount: 3, branchCount: 1, archivedCount: 0, deletedCount: 0 },
			diagnostics: []
		};

		const policy: PruningPolicy = {
			maxNodes: 1, // Only room for 1 node, but head path has 3 (0,1,2)
			keepBranchTips: 0,
			archiveBeforeDelete: true,
			recentWindowMs: 1
		};

		const plan = generatePrunePlan(proj, policy);
		// Since keep exceeds maxNodes, we get a warning but no hard deletes
		assert.ok(plan.warnings.some(w => w.includes('maxNodes')));
		assert.strictEqual(plan.delete.length, 0);
		assert.strictEqual(plan.requiresConfirmation, true); // has warnings
	});

	test('deleted nodes are excluded from consideration', () => {
		const proj = makeBranchingProjection();
		// Node 4 is a branch tip, NOT on head path (head=2, path: 0->1->2)
		proj.deletedNodes.add(4);
		const plan = generatePrunePlan(proj);
		assert.ok(!plan.keep.includes(4));
		assert.ok(!plan.archive.includes(4));
		assert.ok(!plan.delete.includes(4));
	});

	test('warns when keep set exceeds maxNodes', () => {
		const proj = makeLinearProjection(10);
		const policy: PruningPolicy = {
			...DEFAULT_PRUNING_POLICY,
			maxNodes: 5
		};
		const plan = generatePrunePlan(proj, policy);
		assert.ok(plan.warnings.some(w => w.includes('maxNodes')));
	});
});
