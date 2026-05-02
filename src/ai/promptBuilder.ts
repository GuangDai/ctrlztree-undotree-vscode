/**
 * Prompt builder — orchestrates prompt construction from templates and context.
 *
 * WHAT IT DOES:
 *   Picks the right system prompt from promptTemplates for the task,
 *   builds the user message from context, redacts sensitive data,
 *   and assembles a UnifiedAiRequest ready for the provider layer.
 *
 * KEY EXPORTS:
 *   PromptContext — input context for building prompts
 *   buildPrompt(ctx) → {system, userMessages}
 *   buildUnifiedRequest(ctx, model) → UnifiedAiRequest
 *
 * ARCHITECTURAL ROLE:
 *   Thin orchestrator (src/ai/). Delegates prompt text to promptTemplates.ts
 *   and redaction to redactor.ts. Does NOT hardcode token limits or temperature.
 */

import { AiTask, UnifiedAiRequest } from './types';
import { NodeId, EventSeq } from '../history/ids';
import { Projection } from '../history/projection';
import { redactSensitiveData } from './redactor';
import { TASK_SYSTEM_PROMPTS, buildUserPrompt, UserPromptContext } from './promptTemplates';

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
    projection?: Projection;
}

function safeRedact(text: string): string {
    return redactSensitiveData(text).redacted.trim();
}

export function buildPrompt(ctx: PromptContext): {
    system: string;
    userMessages: Array<{ role: 'user'; content: string }>;
} {
    const system = TASK_SYSTEM_PROMPTS[ctx.task];

    const userCtx: UserPromptContext = {
        nodeId: ctx.nodeId ?? 0,
        baseSeq: ctx.baseSeq,
        headNodeId: ctx.headNodeId,
        filePath: safeRedact(ctx.filePath),
        fileLanguage: ctx.fileLanguage,
        diffSummary: safeRedact(ctx.diffSummary),
        parentDiffSummary: ctx.parentDiffSummary ? safeRedact(ctx.parentDiffSummary) : undefined,
        siblingSummaries: ctx.siblingSummaries?.map(safeRedact),
        nearbyNames: ctx.nearbyNames?.map(safeRedact),
        nodeAgeMinutes: ctx.nodeAgeMinutes,
        branchDepth: ctx.branchDepth,
        siblingCount: ctx.siblingCount,
    };

    return {
        system,
        userMessages: [{ role: 'user', content: buildUserPrompt(userCtx) }],
    };
}

/**
 * Build a UnifiedAiRequest.
 * No max_tokens, no tool_mode, no response_format — schema enforcement
 * is via the inline JSON example in the system prompt.
 */
export function buildUnifiedRequest(
    ctx: PromptContext,
    model: string,
): UnifiedAiRequest {
    const prompt = buildPrompt(ctx);

    return {
        task: ctx.task,
        model,
        system: prompt.system,
        messages: prompt.userMessages,
        projection: ctx.projection,
        metadata: {
            promptVersion: 'v2',
            docFingerprint: ctx.docFingerprint,
            headNodeId: ctx.headNodeId,
            baseSeq: ctx.baseSeq,
        },
    };
}
