/**
 * Bridge from AI-generated node updates to the event log.
 *
 * WHAT IT DOES:
 *   Takes validated AI node-update payloads (names, summaries) and emits
 *   RenameEvent / SummarizeEvent entries into the event log. Re-projects
 *   after applying updates.
 *
 * KEY EXPORTS:
 *   applyAiNodeUpdates(ctrl, updates, aiProvenance?) → {applied, skipped}
 *
 * INTERNAL INTERFACE:
 *   AiEventTarget — exposes the private fields of HistoryController that
 *   applyAiNodeUpdates needs (events, projection, nextSeq, docId, needsPersist, log).
 *
 * ARCHITECTURAL ROLE:
 *   Pure history-core module (src/history/). No VS Code imports. The only path
 *   through which AI-generated metadata enters the event log. All input is validated
 *   against the current projection (nodes must exist, not be deleted).
 */

import { NodeId } from './ids';
import { HistoryEvent } from './events';
import { Projection, project } from './projection';
import { Logger } from '../utils/logger';

/** Internal interface exposing the HistoryController fields that applyAiNodeUpdates needs. */
export interface AiEventTarget {
    events: HistoryEvent[];
    projection: Projection;
    nextSeq: number;
    docId: string;
    needsPersist: boolean;
    log?: Logger;
    genTxId(): string;
}

export function applyAiNodeUpdates(
    ctrl: AiEventTarget,
    updates: Array<{ nodeId: NodeId; name?: string; summary?: string }>,
    aiProvenance?: { provider: string; model: string; confidence?: number }
): { applied: number; skipped: number } {
    const proj = ctrl.projection;
    let applied = 0;
    let skipped = 0;

    for (const update of updates) {
        if (!proj.byId.has(update.nodeId) || proj.deletedNodes.has(update.nodeId)) {
            skipped++;
            continue;
        }
        if (update.name !== undefined && update.name.trim().length > 0) {
            const renameEvent: import('./events').RenameEvent = {
                kind: 'rename',
                schemaVersion: 1,
                seq: ctrl.nextSeq++,
                at: Date.now(),
                txId: ctrl.genTxId(),
                source: 'ai-plan',
                nodeId: update.nodeId,
                name: update.name.trim(),
                ai: aiProvenance ? { provider: aiProvenance.provider, model: aiProvenance.model, confidence: aiProvenance.confidence } : undefined,
            };
            ctrl.events.push(renameEvent);
            applied++;
        }
        if (update.summary !== undefined && update.summary.trim().length > 0) {
            const summarizeEvent: import('./events').SummarizeEvent = {
                kind: 'summarize',
                schemaVersion: 1,
                seq: ctrl.nextSeq++,
                at: Date.now(),
                txId: ctrl.genTxId(),
                source: 'ai-plan',
                nodeId: update.nodeId,
                summary: update.summary.trim(),
                ai: aiProvenance ? { provider: aiProvenance.provider, model: aiProvenance.model, confidence: aiProvenance.confidence } : undefined,
            };
            ctrl.events.push(summarizeEvent);
            applied++;
        }
    }

    if (applied > 0) {
        ctrl.projection = project(ctrl.docId, ctrl.events);
        ctrl.needsPersist = true;
        ctrl.log?.debug(`CtrlZTree: applyAiNodeUpdates applied=${applied} skipped=${skipped} events=${ctrl.events.length}`);
    }

    return { applied, skipped };
}
