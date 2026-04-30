import * as assert from 'assert';
import { generateMergePlan } from '../../history/mergeEngine';
import { generateDeletePlan } from '../../history/deleteEngine';
import { Projection, NodeView } from '../../history/projection';

function makeLinearChain(length: number): Projection {
	const byId = new Map<number, NodeView>();
	const parentOf = new Map<number, number | null>();
	const childrenOf = new Map<number, number[]>();

	for (let i = 0; i < length; i++) {
		byId.set(i, { nodeId: i, contentHash: `h-${i}`, protected: false, createdAt: i * 100 });
		parentOf.set(i, i === 0 ? null : i - 1);
		childrenOf.set(i, []);
		if (i > 0) {
			const pc = childrenOf.get(i - 1) ?? [];
			pc.push(i);
			childrenOf.set(i - 1, pc);
		}
	}

	return {
		docId: 'doc1', rootId: 0, headId: length - 1,
		byId, parentOf, childrenOf,
		branchTips: [length - 1],
		namedNodes: [], protectedNodes: new Set(),
		archivedNodes: new Set(), deletedNodes: new Set(),
		contentHashIndex: new Map(), lastSeq: length - 1,
		stats: { nodeCount: length, branchCount: 1, archivedCount: 0, deletedCount: 0 },
		diagnostics: []
	};
}

suite('MergeEngine', () => {
	test('valid linear merge on consecutive nodes', () => {
		const proj = makeLinearChain(5);
		const plan = generateMergePlan(proj, [1, 2]);
		assert.strictEqual(plan.valid, true);
		assert.strictEqual(plan.targetParentId, 0);
	});

	test('invalid merge for nonexistent node', () => {
		const proj = makeLinearChain(3);
		const plan = generateMergePlan(proj, [999]);
		assert.strictEqual(plan.valid, false);
	});

	test('invalid merge of root', () => {
		const proj = makeLinearChain(3);
		const plan = generateMergePlan(proj, [0]);
		assert.strictEqual(plan.valid, false);
	});
});

suite('DeleteEngine', () => {
	test('soft delete on non-head leaf node is valid', () => {
		const proj = makeLinearChain(5);
		// In a linear chain of 5, node 4 (0-indexed) is the head.
		// Delete node 2 (a middle node) instead
		const plan = generateDeletePlan(proj, [2], 'soft');
		assert.ok(plan.warnings.length > 0, 'Should warn about orphaned children');
		assert.strictEqual(plan.valid, false, 'Should be invalid due to orphaned child');
	});

	test('cannot delete head node', () => {
		const proj = makeLinearChain(3);
		const plan = generateDeletePlan(proj, [2], 'soft');
		assert.strictEqual(plan.valid, false);
		assert.ok(plan.warnings.some(w => w.includes('head')));
	});

	test('cannot delete root', () => {
		const proj = makeLinearChain(3);
		const plan = generateDeletePlan(proj, [0], 'soft');
		assert.strictEqual(plan.valid, false);
	});

	test('hard delete requires confirmation', () => {
		const proj = makeLinearChain(5);
		// Set head to 0 so node 4 is not head
		proj.headId = 0;
		const plan = generateDeletePlan(proj, [4], 'hard');
		assert.strictEqual(plan.valid, true);
		assert.strictEqual(plan.requiresConfirmation, true);
	});

	test('protected node deletion warns', () => {
		const proj = makeLinearChain(5);
		proj.protectedNodes.add(3);
		proj.headId = 0;
		const plan = generateDeletePlan(proj, [3], 'soft');
		assert.ok(plan.warnings.some(w => w.includes('protected')));
	});

	test('soft delete on non-head leaf succeeds', () => {
		const proj = makeLinearChain(5);
		proj.headId = 0; // head not at leaf
		const plan = generateDeletePlan(proj, [4], 'soft');
		assert.strictEqual(plan.valid, true);
	});

	test('shared ancestor found for branch delete (outside target set)', () => {
		const proj = makeLinearChain(5);
		proj.headId = 0;
		// delete nodes 2,3,4 - shared ancestor is 1 (parent of 2)
		const plan = generateDeletePlan(proj, [2, 3, 4], 'soft');
		assert.strictEqual(plan.valid, true);
		assert.strictEqual(plan.sharedAncestorId, 1);
	});

	test('warns about orphaned children', () => {
		const proj = makeLinearChain(5);
		proj.headId = 0;
		const plan = generateDeletePlan(proj, [2], 'soft');
		assert.ok(plan.warnings.some(w => w.includes('orphan')));
	});
});
