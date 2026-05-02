import { NodeId, EventSeq } from '../history/ids';
import { Projection } from '../history/projection';

// Sentinel nodeId used when the AI response doesn't target a specific node
// (e.g., plain-text responses). Value -1 avoids collision with root nodeId 0.
export const SENTINEL_NO_NODE = -1;

export type AiTask =
	| 'rename_node'
	| 'summarize_node'
	| 'summarize_branch'
	| 'propose_merge'
	| 'propose_prune'
	| 'propose_delete';

export interface JsonSchema {
	type: 'object';
	properties: Record<string, unknown>;
	required?: string[];
}

export interface UnifiedAiRequest {
	task: AiTask;
	model: string;
	system: string;
	messages: Array<{ role: 'user' | 'assistant'; content: string }>;
	responseSchema: JsonSchema;
	maxOutputTokens: number;
	temperature: number;
	topP: number;
	toolMode: 'none' | 'force_schema_tool';
	parallelToolCalls: boolean;
	projection?: Projection;
	metadata: {
		promptVersion: string;
		docFingerprint: string;
		headNodeId: NodeId;
		baseSeq: EventSeq;
	};
}

export interface AiProvenance {
	provider: string;
	model: string;
	confidence?: number;
}

export interface NodeUpdate {
	nodeId: NodeId;
	name?: string;
	summary?: string;
	confidence?: number;
}

export interface OperationPlanItem {
	operation: 'archive' | 'delete';
	targetIds: NodeId[];
	reason: string;
	risk: 'low' | 'medium' | 'high';
	requiresConfirmation: boolean;
}

export interface UnifiedAiResponse {
	version: '1';
	task: AiTask;
	baseSeq: EventSeq;
	nodeUpdates: NodeUpdate[];
	operationPlan: OperationPlanItem[];
	warnings: string[];
}

export interface AiProviderError {
	ok: false;
	error: string;
	statusCode?: number;
	retryable: boolean;
}
