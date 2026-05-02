import * as assert from 'assert';
import { buildPrompt, buildUnifiedRequest, PromptContext } from '../../ai/promptBuilder';
import { validateAiResponse } from '../../ai/operationPlanner';
import { Projection, NodeView } from '../../history/projection';
import { AiTask } from '../../ai/types';

function makeContext(task: AiTask): PromptContext {
	return {
		task,
		nodeId: 5,
		diffSummary: '+function foo()\n-var x = 1',
		parentDiffSummary: '+import express',
		fileLanguage: 'typescript',
		filePath: 'src/utils/foo.ts',
		headNodeId: 5,
		baseSeq: 10,
		docFingerprint: 'fp-test',
		nearbyNames: ['Add auth middleware', 'Fix type error'],
		nodeAgeMinutes: 5,
		branchDepth: 2,
		siblingCount: 3,
		nodeIds: [3, 4, 5],
		siblingSummaries: ['Added types', 'Refactored', 'Added tests'],
	};
}

suite('PromptBuilder', () => {
	test('buildPrompt returns system, userMessages, and schema', () => {
		const ctx = makeContext('rename_node');
		const result = buildPrompt(ctx);

		assert.ok(result.system.length > 0);
		assert.strictEqual(result.userMessages.length, 1);
		assert.strictEqual(result.userMessages[0].role, 'user');
	});

	test('rename_node prompt mentions diff summary and nearby names', () => {
		const ctx = makeContext('rename_node');
		const result = buildPrompt(ctx);
		const userContent = result.userMessages[0].content;

		assert.ok(userContent.includes('foo'));
		assert.ok(userContent.includes('Add auth middleware'));
		assert.ok(userContent.includes('src/utils/foo.ts'));
	});

	test('summarize_node prompt mentions diff and age', () => {
		const ctx = makeContext('summarize_node');
		const result = buildPrompt(ctx);
		const userContent = result.userMessages[0].content;

		assert.ok(userContent.includes('summary'));
		assert.ok(userContent.includes('5 minutes ago'));
	});

	test('summarize_branch prompt lists nodes', () => {
		const ctx = makeContext('summarize_branch');
		const result = buildPrompt(ctx);
		const userContent = result.userMessages[0].content;

		assert.ok(userContent.includes('Node #3'));
		assert.ok(userContent.includes('Node #4'));
		assert.ok(userContent.includes('Node #5'));
		assert.ok(userContent.includes('Added types'));
	});

	test('propose_prune prompt includes metadata', () => {
		const ctx = makeContext('propose_prune');
		const result = buildPrompt(ctx);
		const userContent = result.userMessages[0].content;

		assert.ok(userContent.includes('Depth: 2'));
		assert.ok(userContent.includes('Siblings: 3'));
		assert.ok(userContent.includes('archive'));
	});

	test('propose_merge prompt includes candidate summaries', () => {
		const ctx = makeContext('propose_merge');
		const result = buildPrompt(ctx);
		const userContent = result.userMessages[0].content;

		assert.ok(userContent.includes('import express'));
		assert.ok(userContent.includes('Added types'));
		assert.ok(userContent.includes('squashed'));
	});

	test('propose_delete prompt warns not to delete head/protected/root', () => {
		const ctx = makeContext('propose_delete');
		const result = buildPrompt(ctx);
		const userContent = result.userMessages[0].content;

		assert.ok(userContent.includes('Never delete'));
	});

	test('buildUnifiedRequest returns complete UnifiedAiRequest', () => {
		const ctx = makeContext('rename_node');
		const req = buildUnifiedRequest(ctx, 'gpt-4o-mini');

		assert.strictEqual(req.task, 'rename_node');
		assert.strictEqual(req.model, 'gpt-4o-mini');
		assert.strictEqual(req.metadata.baseSeq, 10);
		assert.ok(req.system.length > 0);
	});

	test('system prompt differs per task', () => {
		const rename = buildPrompt({ ...makeContext('rename_node'), task: 'rename_node' });
		const prune = buildPrompt({ ...makeContext('rename_node'), task: 'propose_prune' });

		assert.notStrictEqual(rename.system, prune.system);
	});
});

function makeProjection(nodeCount: number, headId?: number): Projection {
	const byId = new Map<number, NodeView>();
	const parentOf = new Map<number, number | null>();
	const childrenOf = new Map<number, number[]>();

	for (let i = 0; i < nodeCount; i++) {
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
		docId: 'doc1', rootId: 0, headId: headId ?? nodeCount - 1,
		byId, parentOf, childrenOf,
		branchTips: [headId ?? nodeCount - 1],
		namedNodes: [], protectedNodes: new Set(),
		archivedNodes: new Set(), deletedNodes: new Set(),
		contentHashIndex: new Map(), lastSeq: nodeCount - 1,
		stats: { nodeCount, branchCount: 1, archivedCount: 0, deletedCount: 0 },
		diagnostics: []
	};
}

suite('AiResponseValidator', () => {
	test('valid response passes', () => {
		const proj = makeProjection(5);
		const result = validateAiResponse({
			version: '1',
			task: 'summarize_node',
			baseSeq: 4,
			nodeUpdates: [{ nodeId: 3, summary: 'Added tests' }],
			operationPlan: [],
			warnings: [],
		}, proj);

		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.errors.length, 0);
	});

	test('rejects stale baseSeq', () => {
		const proj = makeProjection(5);
		const result = validateAiResponse({
			version: '1', task: 'summarize_node', baseSeq: 1,
			nodeUpdates: [], operationPlan: [], warnings: [],
		}, proj);

		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('Stale')));
	});

	test('rejects non-object response', () => {
		const proj = makeProjection(3);
		const result = validateAiResponse(null, proj);
		assert.strictEqual(result.valid, false);
	});

	test('rejects nonexistent nodeId in nodeUpdates', () => {
		const proj = makeProjection(3);
		const result = validateAiResponse({
			version: '1', task: 'summarize_node', baseSeq: 2,
			nodeUpdates: [{ nodeId: 999, summary: 'test' }],
			operationPlan: [], warnings: [],
		}, proj);

		assert.ok(result.errors.some(e => e.includes('unknown')), `Expected error about unknown node, got: ${JSON.stringify(result.errors)}`);
		assert.strictEqual(result.valid, false);
	});

	test('rejects operation targeting head node', () => {
		const proj = makeProjection(5, 3);
		const result = validateAiResponse({
			version: '1', task: 'propose_prune', baseSeq: 4,
			nodeUpdates: [],
			operationPlan: [{ operation: 'archive', targetIds: [3], reason: 'old', risk: 'low', requiresConfirmation: false }],
			warnings: [],
		}, proj);

		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('head')));
	});

	test('requiresConfirmation for delete operations', () => {
		const proj = makeProjection(5, 0); // head at root
		const result = validateAiResponse({
			version: '1', task: 'propose_delete', baseSeq: 4,
			nodeUpdates: [],
			operationPlan: [{ operation: 'delete', targetIds: [4], reason: 'old leaf', risk: 'low', requiresConfirmation: false }],
			warnings: [],
		}, proj);

		assert.strictEqual(result.valid, true); // valid plan
		assert.strictEqual(result.requiresConfirmation, true); // delete always confirms
	});

	test('requiresConfirmation for high risk plans', () => {
		const proj = makeProjection(5, 0);
		const result = validateAiResponse({
			version: '1', task: 'propose_prune', baseSeq: 4,
			nodeUpdates: [],
			operationPlan: [{ operation: 'archive', targetIds: [4], reason: 'test', risk: 'high', requiresConfirmation: false }],
			warnings: [],
		}, proj);

		assert.strictEqual(result.requiresConfirmation, true);
	});

	test('flags destructive plans', () => {
		const proj = makeProjection(5, 0);
		const result = validateAiResponse({
			version: '1', task: 'propose_prune', baseSeq: 4,
			nodeUpdates: [],
			operationPlan: [{ operation: 'archive', targetIds: [4], reason: 'test', risk: 'low', requiresConfirmation: false }],
			warnings: [],
		}, proj);

		assert.strictEqual(result.hasDestructivePlan, true);
	});

	test('rejects empty targetIds in operationPlan', () => {
		const proj = makeProjection(5);
		const result = validateAiResponse({
			version: '1', task: 'propose_prune', baseSeq: 4,
			nodeUpdates: [],
			operationPlan: [{ operation: 'archive', targetIds: [], reason: 'test', risk: 'low', requiresConfirmation: false }],
			warnings: [],
		}, proj);

		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some(e => e.includes('no targetIds')));
	});

	test('protected node requires confirmation', () => {
		const proj = makeProjection(5, 0);
		proj.protectedNodes.add(4);
		const result = validateAiResponse({
			version: '1', task: 'propose_prune', baseSeq: 4,
			nodeUpdates: [],
			operationPlan: [{ operation: 'archive', targetIds: [4], reason: 'test', risk: 'low', requiresConfirmation: false }],
			warnings: [],
		}, proj);

		assert.strictEqual(result.requiresConfirmation, true);
		assert.ok(result.warnings.some(w => w.includes('protected')));
	});
});
