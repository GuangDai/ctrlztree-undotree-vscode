/**
 * Core types for the AI subsystem.
 *
 * WHAT IT DOES:
 *   Defines the request/response types, task enum, and error interface
 *   shared across the entire AI pipeline (providers, prompt builder, AI service).
 *
 * KEY EXPORTS:
 *   AiTask — the 6 task types the AI can perform
 *   UnifiedAiRequest — request sent from promptBuilder to provider
 *   UnifiedAiResponse — structured response returned from AI
 *   OperationPlanItem — a single operation proposal (archive/delete/merge/prune)
 *   NodeUpdate — AI-generated metadata for a single node
 *   AiProviderError — normalized error from provider layer
 *
 * HARD RULES:
 *   - UnifiedAiRequest does NOT carry max_tokens or response_format.
 *     Token limits are a soft hint in the system prompt only.
 *     Schema enforcement is via inline prompt examples.
 *   - temperature and topP are optional; undefined means "don't send."
 */

import { NodeId, EventSeq } from '../history/ids';
import { Projection } from '../history/projection';

export const SENTINEL_NO_NODE = -1;

export type AiTask =
    | 'rename_node'
    | 'summarize_node'
    | 'summarize_branch'
    | 'propose_merge'
    | 'propose_prune'
    | 'propose_delete'
    | 'annotate_node';

export interface JsonSchema {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
}

/**
 * Request sent to an AI provider.
 * Deliberately omits max_tokens, response_format, tool_mode — those are
 * anti-patterns that break non-OpenAI models.
 */
export interface UnifiedAiRequest {
    task: AiTask;
    model: string;
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    temperature?: number;
    topP?: number;
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
    operation: 'archive' | 'delete' | 'merge' | 'prune';
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
