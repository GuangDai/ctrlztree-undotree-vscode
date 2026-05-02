/**
 * Prompt templates for the CtrlZTree AI pipeline.
 *
 * WHAT IT DOES:
 *   Contains all prompt text as exported constants. No TypeScript logic beyond
 *   string concatenation. Engineers and non-programmers can edit prompts here
 *   without touching pipeline code.
 *
 * DESIGN:
 *   Each task template is a self-contained string including:
 *   - System preamble (tool identity)
 *   - JSON format instruction (replaces response_format: json_schema)
 *   - Task-specific instruction (2-4 sentences)
 *   - Concrete JSON example with placeholder values
 *
 * KEY EXPORTS:
 *   TASK_SYSTEM_PROMPTS: Record<AiTask, string> — full system prompt per task
 *   buildUserPrompt(ctx) → string — constructs the user message from context
 */

import { AiTask } from './types';

// ---- Shared preamble ----

const PREAMBLE = 'You are an assistant for an undo-tree version history tool (CtrlZTree). You read code diffs and annotate history nodes.';

// ---- JSON format instruction (replaces response_format: json_schema) ----

const JSON_FORMAT = `Respond ONLY with a single JSON object. No markdown fences, no reasoning, no explanatory text.

The JSON must have this structure:
{
  "task": "<task_name>",
  "baseSeq": <number>,
  "nodeUpdates": [
    {"nodeId": <number>, "name": "<string>", "summary": "<string>", "confidence": <number>}
  ],
  "operationPlan": [
    {"operation": "archive|delete|merge|prune", "targetIds": [<number>], "reason": "<string>", "risk": "low|medium|high", "requiresConfirmation": <boolean>}
  ],
  "warnings": ["<string>"]
}
Always include "operationPlan" (empty array if none) and "warnings" (empty array if none).`;

// ---- Per-task system prompts ----

export const TASK_SYSTEM_PROMPTS: Record<AiTask, string> = {
    rename_node: `${PREAMBLE}

${JSON_FORMAT}

Task: Generate a short, descriptive name (1-6 words) for a history node based on its diff.
The name should describe the purpose of the change.

Example response:
{"task":"rename_node","baseSeq":5,"nodeUpdates":[{"nodeId":5,"name":"Add user authentication"}],"operationPlan":[],"warnings":[]}`,

    summarize_node: `${PREAMBLE}

${JSON_FORMAT}

Task: Write a one-sentence summary of what this history node changed.
Be specific about what was added, removed, or modified.

Example response:
{"task":"summarize_node","baseSeq":5,"nodeUpdates":[{"nodeId":5,"summary":"Added debug logging to the authentication middleware","confidence":0.95}],"operationPlan":[],"warnings":[]}`,

    summarize_branch: `${PREAMBLE}

${JSON_FORMAT}

Task: Write a one-sentence summary for each node in the provided list.
Return one entry per node in the nodeUpdates array.

Example response:
{"task":"summarize_branch","baseSeq":5,"nodeUpdates":[{"nodeId":3,"summary":"Added User model types"},{"nodeId":4,"summary":"Refactored validation logic"}],"operationPlan":[],"warnings":[]}`,

    propose_merge: `${PREAMBLE}

${JSON_FORMAT}

Task: Review the linear chain of diffs. If consecutive nodes represent small, related edits (typing bursts, whitespace-only, incremental feature touches), propose merging them.

Example (merge candidates found):
{"task":"propose_merge","baseSeq":5,"nodeUpdates":[],"operationPlan":[{"operation":"merge","targetIds":[3,4],"reason":"Typing burst: same function edited across 2 saves","risk":"low","requiresConfirmation":false}],"warnings":[]}

Example (no candidates):
{"task":"propose_merge","baseSeq":5,"nodeUpdates":[],"operationPlan":[],"warnings":[]}`,

    propose_prune: `${PREAMBLE}

${JSON_FORMAT}

Task: Identify low-value intermediate nodes for archival. Keep: head-path nodes, branch tips, and recent nodes. Flag old intermediate nodes with small diffs.

Example response:
{"task":"propose_prune","baseSeq":5,"nodeUpdates":[],"operationPlan":[{"operation":"archive","targetIds":[3],"reason":"3 hours old, 1-line whitespace change, not on head path","risk":"low","requiresConfirmation":false}],"warnings":["Node 2 kept: on head path"]}`,

    propose_delete: `${PREAMBLE}

${JSON_FORMAT}

Task: Identify nodes safe for deletion. NEVER target: head node, root node (0), or protected nodes. Only dead-end branches with no active work.

Example response:
{"task":"propose_delete","baseSeq":5,"nodeUpdates":[],"operationPlan":[{"operation":"delete","targetIds":[8],"reason":"Abandoned branch, 6 hours old, no descendants","risk":"medium","requiresConfirmation":true}],"warnings":[]}`,
	annotate_node: `${PREAMBLE}

${JSON_FORMAT}

Task: Generate both a short descriptive name (1-6 words) and a concise summary (1-3 sentences) for a history node based on its diff.
The name should describe the purpose of the change.
The summary should capture what changed and why.

Example response:
{"task":"annotate_node","baseSeq":5,"nodeUpdates":[{"nodeId":5,"name":"Add user authentication","summary":"Added login form and auth middleware to protect API routes"}],"operationPlan":[],"warnings":[]}`,
};

// ---- User message builder ----

export interface UserPromptContext {
    nodeId: number;
    baseSeq: number;
    headNodeId: number;
    filePath: string;
    fileLanguage: string;
    diffSummary: string;
    parentDiffSummary?: string;
    siblingSummaries?: string[];
    nearbyNames?: string[];
    nodeAgeMinutes?: number;
    branchDepth?: number;
    siblingCount?: number;
}

/**
 * Build the user message from context.
 * nodeId and baseSeq are repeated explicitly so the model can copy them into the JSON output.
 */
export function buildUserPrompt(ctx: UserPromptContext): string {
    const lines: string[] = [];
    lines.push(`File: ${ctx.filePath}`);
    lines.push(`Language: ${ctx.fileLanguage}`);
    lines.push(`nodeId: ${ctx.nodeId}`);
    lines.push(`baseSeq: ${ctx.baseSeq}`);
    lines.push(`headNodeId: ${ctx.headNodeId}`);
    lines.push('');
    lines.push(`Diff: ${ctx.diffSummary}`);

    if (ctx.parentDiffSummary) {
        lines.push(`Parent diff: ${ctx.parentDiffSummary}`);
    }
    if (ctx.nearbyNames && ctx.nearbyNames.length > 0) {
        lines.push(`Nearby names: ${ctx.nearbyNames.join(', ')}`);
    }
    if (ctx.siblingSummaries && ctx.siblingSummaries.length > 0) {
        lines.push('Sibling diffs:');
        for (const s of ctx.siblingSummaries) {
            lines.push(`  ${s}`);
        }
    }
    if (ctx.nodeAgeMinutes !== undefined) {
        lines.push(`Age: ${ctx.nodeAgeMinutes}m`);
    }
    if (ctx.branchDepth !== undefined) {
        lines.push(`Branch depth: ${ctx.branchDepth}`);
    }
    if (ctx.siblingCount !== undefined) {
        lines.push(`Sibling count: ${ctx.siblingCount}`);
    }
    return lines.join('\n');
}
