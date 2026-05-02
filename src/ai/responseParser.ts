/**
 * Robust JSON extraction from LLM text output.
 *
 * WHAT IT DOES:
 *   Extracts a UnifiedAiResponse from raw model text output, handling:
 *   - ```json fences (some models wrap despite instructions)
 *   - JSON embedded in natural language text ("Here's the result: {...}")
 *   - Trailing commas (common LLM JSON mistake)
 *   - Empty/missing fields (fills safe defaults)
 *
 * KEY EXPORTS:
 *   parseRobustJson(text) → {ok, response} | {ok:false, error}
 *
 * ARCHITECTURAL ROLE:
 *   Pure utility (src/ai/). No VS Code imports. Called by base.ts in the
 *   response parsing pipeline. Replaces the fragile JSON.parse() scattered
 *   across all 4 provider files.
 */

import { UnifiedAiResponse, AiTask } from './types';

interface ParseOk {
    ok: true;
    response: UnifiedAiResponse;
}
interface ParseErr {
    ok: false;
    error: string;
}
type ParseResult = ParseOk | ParseErr;

export function parseRobustJson(text: string): ParseResult {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return { ok: false, error: 'Empty response' };
    }

    // Attempt 1: Direct JSON parse
    const direct = tryParseAsResponse(trimmed);
    if (direct) { return { ok: true, response: direct }; }

    // Attempt 2: Strip ```json ... ``` or ``` ... ``` fences
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
        const fenced = tryParseAsResponse(fenceMatch[1].trim());
        if (fenced) { return { ok: true, response: fenced }; }
    }

    // Attempt 3: Find the largest balanced JSON object in the text
    const objects = extractJsonObjects(trimmed);
    for (const obj of objects.reverse()) {
        const parsed = tryParseAsResponse(obj);
        if (parsed) { return { ok: true, response: parsed }; }
    }

    // Attempt 4: Try with trailing comma cleanup
    for (const obj of objects) {
        const cleaned = obj
            .replace(/,\s*}/g, '}')
            .replace(/,\s*\]/g, ']');
        const parsed = tryParseAsResponse(cleaned);
        if (parsed) { return { ok: true, response: parsed }; }
    }

    return { ok: false, error: 'No valid JSON object found in response' };
}

function tryParseAsResponse(text: string): UnifiedAiResponse | null {
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return normalizeResponse(parsed);
        }
    } catch {
        // Continue to next strategy
    }
    return null;
}

function normalizeResponse(obj: Record<string, unknown>): UnifiedAiResponse {
    const task = (typeof obj.task === 'string' ? obj.task : 'summarize_node') as AiTask;
    const baseSeq = typeof obj.baseSeq === 'number' ? obj.baseSeq : -1;

    const nodeUpdates = Array.isArray(obj.nodeUpdates)
        ? (obj.nodeUpdates as any[]).map((u: any) => ({
            nodeId: typeof u.nodeId === 'number' ? u.nodeId : 0,
            name: typeof u.name === 'string' ? u.name : undefined,
            summary: typeof u.summary === 'string' ? u.summary : undefined,
            confidence: typeof u.confidence === 'number'
                ? Math.max(0, Math.min(1, u.confidence))
                : undefined,
        }))
        : [];

    const operationPlan = Array.isArray(obj.operationPlan)
        ? (obj.operationPlan as any[]).map((p: any) => ({
            operation: (['archive', 'delete', 'merge', 'prune'].includes(p.operation) ? p.operation : 'archive') as 'archive' | 'delete' | 'merge' | 'prune',
            targetIds: Array.isArray(p.targetIds)
                ? p.targetIds.filter((id: unknown) => typeof id === 'number')
                : [],
            reason: typeof p.reason === 'string' ? p.reason : 'No reason provided',
            risk: (['low', 'medium', 'high'].includes(p.risk) ? p.risk : 'low') as 'low' | 'medium' | 'high',
            requiresConfirmation: Boolean(p.requiresConfirmation),
        }))
        : [];

    const warnings: string[] = Array.isArray(obj.warnings)
        ? (obj.warnings as unknown[]).filter((w): w is string => typeof w === 'string')
        : [];

    return {
        version: '1',
        task,
        baseSeq,
        nodeUpdates,
        operationPlan,
        warnings,
    };
}

/**
 * Extract all balanced `{...}` JSON object strings from text.
 * Respects string escaping to avoid false matches on braces inside strings.
 */
function extractJsonObjects(text: string): string[] {
    const results: string[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }
        if (ch === '\\') {
            escapeNext = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) { continue; }

        if (ch === '{') {
            if (depth === 0) { start = i; }
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
                results.push(text.substring(start, i + 1));
                start = -1;
            }
        }
    }

    return results;
}
