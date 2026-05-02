/**
 * Persistence layer for the event-driven history model.
 *
 * WHAT IT DOES:
 *   Serializes and restores a HistoryController's event log and ContentStore state
 *   to/from AES-GCM-encrypted persistence. Handles event log compaction to bound memory.
 *
 * KEY EXPORTS:
 *   fromPersistedEvents(deps, events, contentEntries?) → Promise<HistoryController>
 *   flushControllerToDisk(controller) → Promise<{ok}|{ok:false, error}>
 *   compactControllerEvents(controller) → void
 *
 * INTERNAL INTERFACE:
 *   PersistableController — exposes the private fields of HistoryController that
 *   these functions need (events, projection, contentStore, queue, persistenceService,
 *   hashToNodeId, nodeIdToHash, nextNodeId, nextSeq, nextTxId, needsPersist, log, tree, docId).
 *
 * ARCHITECTURAL ROLE:
 *   Pure history-core module (src/history/). No VS Code imports. Bridges the in-memory
 *   event log + projection model with the security/persistenceService layer.
 */

import * as crypto from 'crypto';
import { NodeId, EventSeq } from './ids';
import { HistoryEvent } from './events';
import { Projection, project } from './projection';
import { CtrlZTree } from '../model/ctrlZTree';
import { DocumentTaskQueue } from '../concurrency/documentTaskQueue';
import { MemoryContentStore } from './contentStore';
import { PersistenceService } from '../security/persistenceService';
import { Logger } from '../utils/logger';
import { HistoryControllerDeps, HistoryController } from './historyController';

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Subset of HistoryController's internal state needed by persistence operations.
 * Defined here (not exported from historyController.ts) to keep private fields private.
 */
export interface PersistableController {
    docId: string;
    tree: CtrlZTree;
    queue: DocumentTaskQueue;
    contentStore?: MemoryContentStore;
    persistenceService?: PersistenceService;
    log?: Logger;
    events: HistoryEvent[];
    projection: Projection;
    nextNodeId: NodeId;
    nextSeq: EventSeq;
    nextTxId: number;
    hashToNodeId: Map<string, NodeId>;
    nodeIdToHash: Map<NodeId, string>;
    needsPersist: boolean;
    mapHash(hash: string, nodeId: NodeId): void;
    genTxId(): string;
}

export async function fromPersistedEvents(
    deps: HistoryControllerDeps,
    events: HistoryEvent[],
    contentEntries?: Array<{ nodeId: number; content: string }>
): Promise<HistoryController> {
    const controller = new HistoryController(deps);
    const ctrl = controller as unknown as PersistableController;

    ctrl.events = events;
    ctrl.nextSeq = events.length > 0 ? Math.max(...events.map(e => e.seq)) + 1 : 0;

    ctrl.hashToNodeId.clear();
    ctrl.nodeIdToHash.clear();
    ctrl.mapHash(ctrl.tree.getInternalRootHash(), 0);

    let maxNodeId = 0;
    for (const event of events) {
        const ids: number[] = [];
        if ('nodeId' in event) { ids.push((event as any).nodeId); }
        if (event.kind === 'headMove') { ids.push((event as any).from, (event as any).to); }
        if (event.kind === 'merge') { ids.push((event as any).resultId, (event as any).parentId); }
        if (event.kind === 'archive' || event.kind === 'delete') { ids.push(...((event as any).nodeIds ?? [])); }
        if (event.kind === 'reset') { ids.push((event as any).newRootId); }
        if (event.kind === 'edit') { ids.push((event as any).parentId); }
        for (const id of ids) {
            if (typeof id === 'number' && id > maxNodeId) {
                maxNodeId = id;
            }
        }
    }
    ctrl.nextNodeId = maxNodeId + 1;

    let maxTx = 0;
    for (const event of events) {
        const match = event.txId?.match(/^tx-(\d+)$/);
        if (match) {
            const n = parseInt(match[1], 10);
            if (n >= maxTx) { maxTx = n + 1; }
        }
    }
    ctrl.nextTxId = maxTx;

    if (contentEntries && ctrl.contentStore) {
        for (const entry of contentEntries) {
            ctrl.contentStore.putSnapshot(entry.nodeId, entry.content);
        }
    }

    ctrl.projection = project(ctrl.docId, ctrl.events);

    if (ctrl.contentStore) {
        const proj = ctrl.projection;
        const headPath: number[] = [];
        let c: number | null = proj.headId;
        while (c !== null) {
            headPath.push(c);
            c = proj.parentOf.get(c) ?? null;
        }
        headPath.reverse();
        for (const nodeId of headPath) {
            if (nodeId === proj.rootId) { continue; }
            const nodeContent = ctrl.contentStore.resolve(nodeId, proj);
            if (nodeContent !== null) {
                const nodeView = proj.byId.get(nodeId);
                ctrl.tree.set(nodeContent, undefined, nodeView?.createdAt);
            }
        }
    }

    for (const [hash, node] of ctrl.tree.getAllNodes()) {
        const internalRoot = ctrl.tree.getInternalRootHash();
        if (hash === internalRoot) { continue; }
        const content = ctrl.tree.getContent(hash);
        const contentHash = sha256(content);
        const candidateIds = ctrl.projection.contentHashIndex.get(contentHash) ?? [];
        if (candidateIds.length === 0) { continue; }
        let matchedId: number | undefined;
        if (node.parent) {
            const parentNodeId = ctrl.hashToNodeId.get(node.parent);
            if (parentNodeId !== undefined) {
                for (const cid of candidateIds) {
                    if (ctrl.projection.parentOf.get(cid) === parentNodeId) {
                        matchedId = cid;
                        break;
                    }
                }
            }
        }
        if (matchedId === undefined) {
            for (const cid of candidateIds) {
                if (!ctrl.nodeIdToHash.has(cid)) {
                    matchedId = cid;
                    break;
                }
            }
        }
        if (matchedId === undefined) {
            matchedId = candidateIds[0];
        }
        ctrl.mapHash(hash, matchedId);
    }

    ctrl.needsPersist = false;
    ctrl.log?.info(`CtrlZTree: Restored ${events.length} events${contentEntries ? ` + ${contentEntries.length} snapshots` : ''} from persistence`);
    return controller;
}

export async function flushControllerToDisk(ctrl: PersistableController): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!ctrl.needsPersist || !ctrl.persistenceService) {
        return { ok: true };
    }
    const result = await ctrl.queue.enqueue(ctrl.docId, 'flush', async (token) => {
        if (token.cancelled) { return { ok: false as const, error: 'Flush cancelled' }; }
        if (!ctrl.needsPersist || !ctrl.persistenceService) {
            return { ok: true as const };
        }
        const fingerprint = PersistenceService.computeFingerprint(ctrl.docId);
        let contentEntries: Array<{ nodeId: number; content: string }> | undefined;
        if (ctrl.contentStore) {
            const proj = ctrl.projection;
            contentEntries = [];
            let cursor: number | null = proj.headId;
            let depth = 0;
            const maxDepth = 64;
            while (cursor !== null && depth < maxDepth) {
                const content = ctrl.contentStore.resolve(cursor, proj);
                if (content !== null) {
                    contentEntries.push({ nodeId: cursor, content });
                }
                cursor = proj.parentOf.get(cursor) ?? null;
                depth++;
            }
        }
        const saveResult = await ctrl.persistenceService.saveDocument(
            fingerprint,
            ctrl.events,
            ctrl.projection.lastSeq,
            contentEntries,
        );
        if (saveResult.ok) {
            ctrl.needsPersist = false;
        } else {
            ctrl.log?.warn(`CtrlZTree: flushToDisk failed for ${ctrl.docId}: ${saveResult.error}`);
        }
        return saveResult;
    });
    return result;
}

export function compactControllerEvents(ctrl: PersistableController): void {
    const MAX_EVENTS = 5000;
    if (ctrl.events.length <= MAX_EVENTS) { return; }

    const keepFrom = ctrl.events.length - Math.floor(MAX_EVENTS * 0.8);
    const compacted: HistoryEvent[] = [];

    for (let i = 0; i < ctrl.events.length; i++) {
        const e = ctrl.events[i];
        if (e.kind === 'headMove' && i < keepFrom) {
            continue;
        }
        compacted.push(e);
    }

    if (compacted.length < ctrl.events.length) {
        ctrl.log?.info(`CtrlZTree: Compacted events from ${ctrl.events.length} to ${compacted.length}`);
        ctrl.events = compacted;
        ctrl.projection = project(ctrl.docId, ctrl.events);
        const referencedIds = new Set<number>();
        for (const e of compacted) {
            const ids: number[] = [];
            if ('nodeId' in e) { ids.push((e as any).nodeId); }
            if (e.kind === 'headMove') { ids.push((e as any).from, (e as any).to); }
            if (e.kind === 'headMove' || e.kind === 'edit') { ids.push((e as any).parentId); }
            if (e.kind === 'merge') { ids.push((e as any).resultId, (e as any).parentId); }
            if (e.kind === 'archive' || e.kind === 'delete') { ids.push(...((e as any).nodeIds ?? [])); }
            if (e.kind === 'reset') { ids.push((e as any).newRootId); }
            for (const id of ids) {
                if (typeof id === 'number' && !isNaN(id)) { referencedIds.add(id); }
            }
        }
        for (const [nodeId, hash] of new Map(ctrl.nodeIdToHash)) {
            if (!referencedIds.has(nodeId)) {
                ctrl.nodeIdToHash.delete(nodeId);
                ctrl.hashToNodeId.delete(hash);
            }
        }
        ctrl.needsPersist = true;
    }
}
