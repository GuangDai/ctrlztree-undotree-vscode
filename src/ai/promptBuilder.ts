import { AiTask, JsonSchema, UnifiedAiRequest } from './types';
import { NodeId, EventSeq } from '../history/ids';

export interface PromptContext {
	task: AiTask;
	nodeId?: NodeId;
	nodeIds?: NodeId[];
	diffSummary: string;
	parentDiffSummary?: string;
	siblingSummaries?: string[];
	fileLanguage: string;
	filePath: string;
	headNodeId: NodeId;
	baseSeq: EventSeq;
	docFingerprint: string;
	nearbyNames?: string[];
	nodeAgeMinutes?: number;
	branchDepth?: number;
	siblingCount?: number;
}

const RESPONSE_SCHEMA: JsonSchema = {
	type: 'object',
	properties: {
		task: { type: 'string', enum: ['rename_node', 'summarize_node', 'summarize_branch', 'propose_merge', 'propose_prune', 'propose_delete'] },
		baseSeq: { type: 'number' },
		nodeUpdates: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					nodeId: { type: 'number' },
					name: { type: 'string' },
					summary: { type: 'string' },
					confidence: { type: 'number' }
				}
			}
		},
		operationPlan: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					operation: { type: 'string', enum: ['archive', 'delete'] },
					targetIds: { type: 'array', items: { type: 'number' } },
					reason: { type: 'string' },
					risk: { type: 'string', enum: ['low', 'medium', 'high'] },
					requiresConfirmation: { type: 'boolean' }
				}
			}
		},
		warnings: { type: 'array', items: { type: 'string' } }
	},
	required: ['task', 'baseSeq', 'nodeUpdates', 'operationPlan', 'warnings']
};

function buildSystemPrompt(task: AiTask): string {
	const base = 'You are an assistant for an undo-tree version history tool (CtrlZTree). ';

	const taskPrompts: Record<AiTask, string> = {
		rename_node: 'Generate a short, descriptive name for a history node based on its diff summary. The name should be 1-6 words, describing the purpose of the change. Return the name in nodeUpdates[0].name.',
		summarize_node: 'Generate a one-sentence summary of what changed in this history node based on its diff. Be specific about what was added, removed, or modified. Return the summary in nodeUpdates[0].summary.',
		summarize_branch: 'Generate concise summaries for the provided list of history nodes. Each summary should describe what the node changed. Return summaries in the nodeUpdates array, one per node.',
		propose_merge: 'Review the provided linear chain of consecutive history nodes. If they represent small, related changes (typing bursts, whitespace-only, single-feature incremental edits), propose merging them. Place the proposed merge target IDs in operationPlan. Set risk to low for simple merges, medium if there are semantic considerations.',
		propose_prune: 'Review the provided history node metadata (age, branch depth, diff sizes). Identify low-value intermediate nodes that could be archived to reduce tree size. Prioritize keeping: current head path, branch tips, recent nodes. Place archive suggestions in operationPlan with risk assessment. Never suggest deleting the head node or protected nodes.',
		propose_delete: 'Review the provided leaf/branch node metadata. Identify nodes that could be safely soft-deleted (archived) or hard-deleted. Never suggest deleting: the head node, protected nodes, or the root. Place suggestions in operationPlan with requiresConfirmation=true.',
	};

	return base + taskPrompts[task];
}

function buildUserMessage(ctx: PromptContext): string {
	const parts: string[] = [];

	parts.push(`File: ${ctx.filePath}`);
	parts.push(`Language: ${ctx.fileLanguage}`);
	parts.push(`Current head node: #${ctx.headNodeId}`);
	parts.push(`Document event sequence: ${ctx.baseSeq}`);
	parts.push('');

	switch (ctx.task) {
		case 'rename_node':
			parts.push(`Node #${ctx.nodeId} diff summary: ${ctx.diffSummary}`);
			if (ctx.parentDiffSummary) {
				parts.push(`Parent node diff: ${ctx.parentDiffSummary}`);
			}
			if (ctx.nearbyNames && ctx.nearbyNames.length > 0) {
				parts.push(`Nearby node names for context: ${ctx.nearbyNames.join(', ')}`);
			}
			parts.push('');
			parts.push('Suggest a short name for this node.');
			break;

		case 'summarize_node':
			parts.push(`Node #${ctx.nodeId} diff summary: ${ctx.diffSummary}`);
			parts.push(`Age: ${ctx.nodeAgeMinutes ?? 'unknown'} minutes ago`);
			parts.push('');
			parts.push('Write a one-sentence summary of this change.');
			break;

		case 'summarize_branch':
			parts.push(`Branch with ${ctx.nodeIds?.length ?? 0} nodes:`);
			if (ctx.nodeIds && ctx.siblingSummaries) {
				for (let i = 0; i < Math.min(ctx.nodeIds.length, ctx.siblingSummaries.length); i++) {
					parts.push(`  Node #${ctx.nodeIds[i]}: ${ctx.siblingSummaries[i]}`);
				}
			}
			parts.push('');
			parts.push('Write a summary for each node.');
			break;

		case 'propose_merge':
			parts.push('Linear chain candidates for merge:');
			parts.push(`  Parent diff: ${ctx.parentDiffSummary || 'none'}`);
			if (ctx.siblingSummaries) {
				for (const s of ctx.siblingSummaries) {
					parts.push(`  ${s}`);
				}
			}
			parts.push('');
			parts.push('Propose merge operations if these changes can be safely squashed.');
			break;

		case 'propose_prune':
			parts.push('Node metadata for pruning analysis:');
			parts.push(`  Depth: ${ctx.branchDepth ?? 0}`);
			parts.push(`  Siblings: ${ctx.siblingCount ?? 0}`);
			parts.push(`  Age: ${ctx.nodeAgeMinutes ?? 'unknown'} min`);
			parts.push(`  Diff: ${ctx.diffSummary}`);
			parts.push('');
			parts.push('Identify nodes that can be archived to save space. Do NOT delete the head node.');
			break;

		case 'propose_delete':
			parts.push('Node metadata for deletion analysis:');
			parts.push(`  Diff: ${ctx.diffSummary}`);
			parts.push(`  Branch depth: ${ctx.branchDepth ?? 0}`);
			parts.push('');
			parts.push('Suggest safe deletion candidates. Never delete head/protected/root nodes.');
			break;
	}

	return parts.join('\n');
}

export function buildPrompt(ctx: PromptContext): {
	system: string;
	userMessages: Array<{ role: 'user'; content: string }>;
	responseSchema: JsonSchema;
} {
	return {
		system: buildSystemPrompt(ctx.task),
		userMessages: [{ role: 'user', content: buildUserMessage(ctx) }],
		responseSchema: RESPONSE_SCHEMA
	};
}

export function buildUnifiedRequest(ctx: PromptContext, model: string, toolMode: 'none' | 'force_schema_tool' = 'force_schema_tool'): UnifiedAiRequest {
	const prompt = buildPrompt(ctx);

	return {
		task: ctx.task,
		model,
		system: prompt.system,
		messages: prompt.userMessages,
		responseSchema: prompt.responseSchema,
		maxOutputTokens: 512,
		temperature: 0.2,
		topP: 1,
		toolMode,
		parallelToolCalls: false,
		metadata: {
			promptVersion: 'v1',
			docFingerprint: ctx.docFingerprint,
			headNodeId: ctx.headNodeId,
			baseSeq: ctx.baseSeq,
		}
	};
}
