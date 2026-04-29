import * as assert from 'assert';
import { validateOperationPlan, HistoryOperationPlan } from '../../history/operationPlan';
import { Projection } from '../../history/projection';
import { NodeView } from '../../history/projection';

function makeProjection(nodes: Array<{ id: number; parent: number | null; protected?: boolean }>, headId?: number, lastSeq = 5): Projection {
	const byId = new Map<number, NodeView>();
	const parentOf = new Map<number, number | null>();
	const childrenOf = new Map<number, number[]>();

	for (const n of nodes) {
		byId.set(n.id, { nodeId: n.id, contentHash: `hash-${n.id}`, protected: n.protected ?? false, createdAt: n.id * 100 });
		parentOf.set(n.id, n.parent);
		childrenOf.set(n.id, []);
	}

	for (const n of nodes) {
		if (n.parent !== null) {
			const children = childrenOf.get(n.parent) ?? [];
			children.push(n.id);
			childrenOf.set(n.parent, children);
		}
	}

	const root = nodes.find(n => n.parent === null) ?? nodes[0];
	return {
		docId: 'doc1',
		rootId: root.id,
		headId: headId ?? root.id,
		byId,
		parentOf,
		childrenOf,
		branchTips: [headId ?? root.id],
		namedNodes: [],
		protectedNodes: new Set(nodes.filter(n => n.protected).map(n => n.id)),
		archivedNodes: new Set(),
		deletedNodes: new Set(),
		contentHashIndex: new Map(),
		lastSeq,
		stats: { nodeCount: nodes.length, branchCount: 1, archivedCount: 0, deletedCount: 0 },
		diagnostics: []
	};
}

function makePlan(overrides: Partial<HistoryOperationPlan> = {}): HistoryOperationPlan {
	return {
		version: '1',
		docId: 'doc1',
		baseSeq: 5,
		operation: 'archive',
		targetIds: [2],
		preview: { affectedNodes: [2], estimatedBytesFreed: 100, restorationPath: 'restore from archive' },
		risk: 'low',
		requiresConfirmation: false,
		generatedBy: 'user',
		warnings: [],
		...overrides
	};
}

suite('OperationPlan Validation', () => {
	test('valid archive plan passes', () => {
		const proj = makeProjection([{ id: 0, parent: null }, { id: 1, parent: 0 }, { id: 2, parent: 1 }]);
		const plan = makePlan({ targetIds: [2], operation: 'archive' });
		const result = validateOperationPlan(plan, proj);
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.errors.length, 0);
	});

	test('rejects stale baseSeq', () => {
		const proj = makeProjection([{ id: 0, parent: null }, { id: 1, parent: 0 }]);
		const plan = makePlan({ baseSeq: 3 }); // current is 5
		const result = validateOperationPlan(plan, proj);
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('Stale')));
	});

	test('rejects nonexistent target', () => {
		const proj = makeProjection([{ id: 0, parent: null }]);
		const plan = makePlan({ targetIds: [999] });
		const result = validateOperationPlan(plan, proj);
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('does not exist')));
	});

	test('rejects delete on head node', () => {
		const proj = makeProjection([{ id: 0, parent: null }, { id: 1, parent: 0 }], 1);
		const plan = makePlan({ targetIds: [1], operation: 'delete' });
		const result = validateOperationPlan(plan, proj);
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('head')));
	});

	test('rejects archive on head node', () => {
		const proj = makeProjection([{ id: 0, parent: null }, { id: 1, parent: 0 }], 1);
		const plan = makePlan({ targetIds: [1], operation: 'archive' });
		const result = validateOperationPlan(plan, proj);
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('head')));
	});

	test('rejects operation on root node', () => {
		const proj = makeProjection([{ id: 0, parent: null }, { id: 1, parent: 0 }]);
		const plan = makePlan({ targetIds: [0], operation: 'archive' });
		const result = validateOperationPlan(plan, proj);
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('root')));
	});

	test('warns about protected nodes', () => {
		const proj = makeProjection([{ id: 0, parent: null }, { id: 1, parent: 0, protected: true }]);
		const plan = makePlan({ targetIds: [1] });
		const result = validateOperationPlan(plan, proj);
		assert.ok(result.warnings.some(w => w.includes('protected')));
	});

	test('high risk without confirmation is error', () => {
		const proj = makeProjection([{ id: 0, parent: null }, { id: 1, parent: 0 }]);
		const plan = makePlan({ risk: 'high', requiresConfirmation: false, targetIds: [1] });
		const result = validateOperationPlan(plan, proj);
		assert.strictEqual(result.valid, false);
	});

	test('rejects unsupported plan version', () => {
		const proj = makeProjection([{ id: 0, parent: null }]);
		const plan = makePlan({ version: '2' as any });
		const result = validateOperationPlan(plan, proj);
		assert.strictEqual(result.valid, false);
	});

	test('delete on branch warns about orphaned children', () => {
		const proj = makeProjection([
			{ id: 0, parent: null },
			{ id: 1, parent: 0 },
			{ id: 2, parent: 1 }
		]);
		const plan = makePlan({ targetIds: [1], operation: 'delete' });
		const result = validateOperationPlan(plan, proj);
		assert.ok(result.warnings.some(w => w.includes('orphaned')));
	});

	test('rename on protected node passes', () => {
		const proj = makeProjection([{ id: 0, parent: null }, { id: 1, parent: 0, protected: true }]);
		const plan = makePlan({ targetIds: [1], operation: 'rename' });
		const result = validateOperationPlan(plan, proj);
		assert.strictEqual(result.valid, true);
	});
});
