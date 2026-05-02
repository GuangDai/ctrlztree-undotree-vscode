import { DocId, NodeId, EventSeq, TxId, Cursor } from './ids';
import { HistoryEvent, InitEvent, EditEvent, HeadMoveEvent, ContentRef } from './events';
import { Projection, project } from './projection';
import { CtrlZTree } from '../model/ctrlZTree';
import { DocumentTaskQueue } from '../concurrency/documentTaskQueue';
import { MemoryContentStore, SnapshotPolicy } from './contentStore';
import { PersistenceService } from '../security/persistenceService';
import { Logger } from '../utils/logger';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

function sha256(content: string): string {
	return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface HistoryControllerDeps {
	docId: DocId;
	tree: CtrlZTree;
	queue: DocumentTaskQueue;
	contentStore?: MemoryContentStore;
	snapshotPolicy?: SnapshotPolicy;
	persistenceService?: PersistenceService;
	logger?: Logger;
}

export interface CommitResult {
	hash: string;
}

export interface NavigateResult {
	hash: string | null;
	content: string | null;
}

export class HistoryController {
	private docId: DocId;
	private tree: CtrlZTree;
	private queue: DocumentTaskQueue;
	private contentStore?: MemoryContentStore;
	private snapshotPolicy?: SnapshotPolicy;
	private persistenceService?: PersistenceService;
	private log?: Logger;
	private events: HistoryEvent[] = [];
	private projection: Projection;
	private nextNodeId: NodeId = 0;
	private nextSeq: EventSeq = 0;
	private nextTxId = 0;
	private hashToNodeId = new Map<string, NodeId>();
	private nodeIdToHash = new Map<NodeId, string>();
	private needsPersist = false;

	private safeGetTreeHead(): string | null {
		const head = this.tree.getHead();
		if (head === null) {
			this.log?.error('CtrlZTree: getHead() returned null — projection/tree may be desynchronized');
		}
		return head;
	}

	constructor(deps: HistoryControllerDeps) {
		this.docId = deps.docId;
		this.tree = deps.tree;
		this.queue = deps.queue;
		this.contentStore = deps.contentStore;
		this.snapshotPolicy = deps.snapshotPolicy;
		this.persistenceService = deps.persistenceService;
		this.log = deps.logger;

		const rootHash = this.tree.getInternalRootHash();
		const rootContent = this.tree.getContent(rootHash);
		const rootNodeId = this.nextNodeId;
		this.mapHash(rootHash, this.nextNodeId);

		const initEvent: InitEvent = {
			kind: 'init',
			schemaVersion: 1,
			seq: this.nextSeq++,
			at: Date.now(),
			txId: this.genTxId(),
			source: 'system',
			nodeId: this.nextNodeId,
			contentRef: { kind: 'snapshot', bytes: Buffer.byteLength(rootContent, 'utf8') },
			contentHash: sha256(rootContent),
			isNonEmpty: rootContent.length > 0,
			fileSig: { mtime: 0, size: rootContent.length },
		};
		this.nextNodeId++;
		this.events.push(initEvent);

		// Seed ContentStore with root snapshot so resolve() works
		if (this.contentStore) {
			this.contentStore.putSnapshot(rootNodeId, rootContent);
		}

		const initialHash = this.tree.getInitialSnapshotHash();
		if (initialHash !== rootHash && initialHash !== null) {
			const snapContent = this.tree.getContent(initialHash);
			const snapNodeId = this.nextNodeId++;
			this.mapHash(initialHash, snapNodeId);
			const snapEvent: EditEvent = {
				kind: 'edit',
				schemaVersion: 1,
				seq: this.nextSeq++,
				at: Date.now(),
				txId: this.genTxId(),
				source: 'system',
				nodeId: snapNodeId,
				parentId: rootNodeId,
				contentRef: { kind: 'snapshot', bytes: Buffer.byteLength(snapContent, 'utf8') },
				contentHash: sha256(snapContent),
				isNonEmpty: snapContent.length > 0,
				stats: { contentBytes: snapContent.length, diffBytes: 0, lineCount: snapContent.split(/\r?\n/).length },
			};
			this.events.push(snapEvent);

			// Seed ContentStore with initial snapshot so resolve() works
			if (this.contentStore) {
				this.contentStore.putSnapshot(snapNodeId, snapContent);
			}
		}

		this.projection = project(this.docId, this.events);
		this.needsPersist = true; this.log?.debug(`CtrlZTree: init events=${this.events.length}`);
	}

	async commit(content: string, cursor?: vscode.Position): Promise<CommitResult> {
		return this.queue.enqueue(this.docId, 'commit', async (token) => {
			if (token.cancelled) { throw new Error(`Commit cancelled: ${token.cancelReason}`); }
			const oldContent = this.tree.getContent();
			const cursorPos: Cursor | undefined = cursor ? { line: cursor.line, character: cursor.character } : undefined;
			const newHash = this.tree.set(content, cursor);

			if (newHash === this.tree.getHead() && oldContent === content) {
				return { hash: newHash };
			}

			if (!this.hashToNodeId.has(newHash)) {
				this.mapHash(newHash, this.nextNodeId++);
			}
			const nodeId = this.hashToNodeId.get(newHash)!;
			const parentHash = this.tree.getAllNodes().get(newHash)?.parent;
			let parentId: NodeId = this.projection.headId;
			if (parentHash) {
				if (!this.hashToNodeId.has(parentHash)) {
					this.mapHash(parentHash, this.nextNodeId++);
				}
				parentId = this.hashToNodeId.get(parentHash)!;
			}
				if (parentId === 0 && this.projection.rootId !== 0) {
					this.log?.warn(`CtrlZTree: commit parentId resolved to unexpected root; using head ${this.projection.headId}`);
					parentId = this.projection.headId;
				}

			const newContent = this.tree.getContent(newHash);
			const diffStr = this.tree.getAllNodes().get(newHash)?.diff ?? '';
			const diffBytes = Buffer.byteLength(diffStr, 'utf8');

			let contentRef: ContentRef;
			if (this.contentStore) {
				contentRef = this.contentStore.appendEdit(oldContent, newContent, nodeId, this.snapshotPolicy);
			} else {
				contentRef = { kind: 'inline-diff', nodeId, bytes: diffBytes };
			}

			const editEvent: EditEvent = {
				kind: 'edit',
				schemaVersion: 1,
				seq: this.nextSeq++,
				at: Date.now(),
				txId: this.genTxId(),
				source: 'user',
				nodeId,
				parentId,
				contentRef,
				contentHash: sha256(newContent),
				cursor: cursorPos,
				isNonEmpty: newContent.length > 0,
				stats: { contentBytes: newContent.length, diffBytes, lineCount: newContent.split(/\r?\n/).length },
			};
			this.events.push(editEvent);
			try {
				this.projection = project(this.docId, this.events);
			} catch (err: any) {
				this.log?.error(`CtrlZTree: project() failed in commit: ${err?.message}`);
				// Projection is stale but event was already pushed.
				// Next operation will re-project from all events.
			}
			this.needsPersist = true; this.log?.debug(`CtrlZTree: commit events=${this.events.length}`);
			this.log?.debug(`CtrlZTree: commit nodeId=${nodeId} seq=${editEvent.seq} bytes=${newContent.length} events=${this.events.length}`);
			return { hash: newHash };
		});
	}

	async undo(): Promise<NavigateResult> {
		return this.queue.enqueue(this.docId, 'undo', async (token) => {
			if (token.cancelled) { throw new Error(`Undo cancelled: ${token.cancelReason}`); }
			const proj = this.projection;
			const currentHead = proj.headId;
			const parentId = proj.parentOf.get(currentHead);
			if (parentId === undefined || parentId === null) {
				return { hash: null, content: null };
			}
			if (proj.deletedNodes.has(parentId)) {
				return { hash: null, content: null };
			}

			// Record headMove in events/projection without touching legacy tree
			const undoHead = this.safeGetTreeHead();
			if (!undoHead) { return { hash: null, content: null }; }
			if (!this.hashToNodeId.has(undoHead)) {
				this.mapHash(undoHead, this.nextNodeId++);
			}
			const oldNodeId = this.hashToNodeId.get(undoHead)!;
			const newNodeId = parentId; // parentId IS the nodeId from projection

			const headMoveEvent: HeadMoveEvent = {
				kind: 'headMove',
				schemaVersion: 1,
				seq: this.nextSeq++,
				at: Date.now(),
				txId: this.genTxId(),
				source: 'user',
				from: oldNodeId,
				to: newNodeId,
				reason: 'undo',
			};
			this.events.push(headMoveEvent);
			this.projection = project(this.docId, this.events);
			// Sync legacy tree head (single source of truth for content resolution)
			const parentHash = this.tree.peekUndo();
			if (parentHash) { this.tree.z(); }
			const content = this.tree.getContent();
			this.needsPersist = true;
			return { hash: parentHash, content };
		});
	}

	async redo(childHash?: string): Promise<NavigateResult> {
		return this.queue.enqueue(this.docId, 'redo', async (token) => {
			if (token.cancelled) { throw new Error(`Redo cancelled: ${token.cancelReason}`); }
			const proj = this.projection;
			const currentHead = proj.headId;
			const children = proj.childrenOf.get(currentHead) ?? [];
			const visibleChildren = children.filter(c => !proj.deletedNodes.has(c) && !proj.archivedNodes.has(c));

			if (visibleChildren.length === 0) {
				return { hash: null, content: null };
			}

			let targetId: number;
			if (childHash) {
				// Resolve child by hash to nodeId
				const targetNodeId = this.hashToNodeId.get(childHash);
				if (targetNodeId === undefined || !visibleChildren.includes(targetNodeId)) {
					return { hash: null, content: null };
				}
				targetId = targetNodeId;
			} else {
				targetId = visibleChildren[0]; // First visible child
			}

			const redoHead = this.safeGetTreeHead();
			if (!redoHead) { return { hash: null, content: null }; }
			const oldNodeId = this.hashToNodeId.get(redoHead) ?? currentHead;

			const headMoveEvent: HeadMoveEvent = {
				kind: 'headMove',
				schemaVersion: 1,
				seq: this.nextSeq++,
				at: Date.now(),
				txId: this.genTxId(),
				source: 'user',
				from: oldNodeId,
				to: targetId,
				reason: 'redo',
			};
			this.events.push(headMoveEvent);
			this.projection = project(this.docId, this.events);
			// Sync legacy tree head
			if (childHash) { this.tree.setHead(childHash); } else { this.tree.y(); }
			const newHash = this.safeGetTreeHead();
			if (!newHash) { return { hash: null, content: null }; }
			this.needsPersist = true;
			return { hash: newHash, content: this.tree.getContent() };
		});
	}

	async checkout(hash: string): Promise<{ success: boolean; content: string | null }> {
		return this.queue.enqueue(this.docId, 'checkout', async (token) => {
			if (token.cancelled) { throw new Error(`Checkout cancelled: ${token.cancelReason}`); }
			const targetNodeId = this.hashToNodeId.get(hash);
			if (targetNodeId === undefined) {
				// Hash not yet mapped — try to map it now
				const allNodes = this.tree.getAllNodes();
				if (!allNodes.has(hash)) {
					return { success: false, content: null };
				}
				this.mapHash(hash, this.nextNodeId++);
			}
			const finalTargetId = this.hashToNodeId.get(hash)!;
			const proj = this.projection;

			if (proj.deletedNodes.has(finalTargetId)) {
				return { success: false, content: null };
			}
			if (!proj.byId.has(finalTargetId)) {
				return { success: false, content: null };
			}

			const checkoutHead = this.safeGetTreeHead();
			const oldNodeId = checkoutHead ? (this.hashToNodeId.get(checkoutHead) ?? proj.headId) : proj.headId;

			const headMoveEvent: HeadMoveEvent = {
				kind: 'headMove',
				schemaVersion: 1,
				seq: this.nextSeq++,
				at: Date.now(),
				txId: this.genTxId(),
				source: 'user',
				from: oldNodeId,
				to: finalTargetId,
				reason: 'checkout',
			};
			this.events.push(headMoveEvent);
			this.projection = project(this.docId, this.events);
			// Sync legacy tree head
			this.tree.setHead(hash);
			this.needsPersist = true;
			return { success: true, content: this.tree.getContent(hash) };
		});
	}

	getProjection(): Projection {
		return this.projection;
	}

	getTree(): CtrlZTree {
		return this.tree;
	}

	getHead(): string | null {
		return this.tree.getHead();
	}

	getContent(hash?: string): string {
		return this.tree.getContent(hash);
	}

	getEvents(): readonly HistoryEvent[] {
		return this.events;
	}

	executeMergePlan(plan: import('./mergeEngine').MergePlan, resultContent: string): { ok: true; nodeId: number } | { ok: false; error: string } {
		if (!plan.valid) {
			return { ok: false, error: 'Merge plan is not valid' };
		}
		// Filter out already-archived or deleted source nodes to avoid duplicate archive references
		const activeSources = plan.sourceIds.filter(id =>
			!this.projection.archivedNodes.has(id) && !this.projection.deletedNodes.has(id)
		);
		if (activeSources.length === 0) {
			return { ok: false, error: 'All source nodes are already archived or deleted' };
		}
		const resultNodeId = this.nextNodeId++;
		const mergeEvent: import('./events').MergeEvent = {
			kind: 'merge',
			schemaVersion: 1,
			seq: this.nextSeq++,
			at: Date.now(),
			txId: this.genTxId(),
			source: 'user',
			resultId: resultNodeId,
			sourceIds: activeSources,
			parentId: plan.targetParentId,
			contentRef: { kind: 'snapshot', nodeId: resultNodeId, bytes: Buffer.byteLength(resultContent, 'utf8') },
			contentHash: sha256(resultContent),
			archivedSourceIds: activeSources,
			reason: 'User requested linear chain merge',
		};
		this.events.push(mergeEvent);
		// Also set content in legacy tree for consistency
		const mergeHead = this.safeGetTreeHead();
		const parentHash = mergeHead ? this.tree.getAllNodes().get(mergeHead)?.parent : undefined;
		if (parentHash) {
			this.tree.setHead(parentHash);
		}
		this.tree.set(resultContent);
		this.projection = project(this.docId, this.events);
		this.needsPersist = true;
		this.log?.info(`CtrlZTree: Merged ${plan.sourceIds.length} nodes -> #${resultNodeId}`);
		return { ok: true, nodeId: resultNodeId };
	}

	executeDeletePlan(plan: import('./deleteEngine').DeletePlan): { ok: true } | { ok: false; error: string } {
		if (!plan.valid) {
			return { ok: false, error: 'Delete plan is not valid' };
		}
		const event: import('./events').ArchiveEvent = {
			kind: 'archive',
			schemaVersion: 1,
			seq: this.nextSeq++,
			at: Date.now(),
			txId: this.genTxId(),
			source: 'user',
			nodeIds: plan.targetIds,
			reason: 'User requested delete/archive',
		};
		this.events.push(event);
		this.projection = project(this.docId, this.events);
		this.needsPersist = true;
		this.log?.info(`CtrlZTree: Deleted/archived ${plan.targetIds.length} nodes`);
		return { ok: true };
	}

	getNeedsPersist(): boolean {
		return this.needsPersist && this.persistenceService !== undefined;
	}

	setNeedsPersist(value: boolean): void {
		this.needsPersist = value;
	}

	static async fromPersistedEvents(deps: HistoryControllerDeps, events: HistoryEvent[], contentEntries?: Array<{ nodeId: number; content: string }>): Promise<HistoryController> {
		const controller = new HistoryController(deps);
		// Replace auto-generated init/edit events with persisted events
		controller.events = events;
		controller.nextSeq = events.length > 0 ? Math.max(...events.map(e => e.seq)) + 1 : 0;
		// Rebuild hash-to-nodeId mapping from persisted events
		controller.hashToNodeId.clear();
		controller.nodeIdToHash.clear();
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
		controller.nextNodeId = maxNodeId + 1;
		// Rebuild txId counter
		let maxTx = 0;
		for (const event of events) {
			const match = event.txId?.match(/^tx-(\d+)$/);
			if (match) {
				const n = parseInt(match[1], 10);
				if (n >= maxTx) { maxTx = n + 1; }
			}
		}
		(controller as any).nextTxId = maxTx;
		// Restore ContentStore entries if present
		if (contentEntries && controller.contentStore) {
			for (const entry of contentEntries) {
				controller.contentStore.putSnapshot(entry.nodeId, entry.content);
			}
		}
		controller.projection = project(controller.docId, controller.events);
		controller.needsPersist = false; // Just loaded from disk
		controller.log?.info(`CtrlZTree: Restored ${events.length} events${contentEntries ? ` + ${contentEntries.length} snapshots` : ''} from persistence`);
		return controller;
	}

	async flushToDisk(): Promise<{ ok: true } | { ok: false; error: string }> {
		if (!this.needsPersist || !this.persistenceService) {
			return { ok: true };
		}
		const fingerprint = PersistenceService.computeFingerprint(this.docId);
		// Collect ContentStore snapshots for persistence.
		// Only collect snapshots for nodes near head (last 64 entries) to avoid O(n) resolve.
		let contentEntries: Array<{ nodeId: number; content: string }> | undefined;
		if (this.contentStore) {
			const proj = this.projection;
			contentEntries = [];
			// Walk from head upward, collecting snapshots for the head-path chain
			let cursor: number | null = proj.headId;
			let depth = 0;
			const maxDepth = 64;
			while (cursor !== null && depth < maxDepth) {
				if (this.contentStore.hasSnapshot(cursor)) {
					const content = this.contentStore.resolve(cursor, proj);
					if (content !== null) {
						contentEntries.push({ nodeId: cursor, content });
					}
				}
				cursor = proj.parentOf.get(cursor) ?? null;
				depth++;
			}
		}
		const result = await this.persistenceService.saveDocument(
			fingerprint,
			this.events,
			this.projection.lastSeq,
			contentEntries,
		);
		if (result.ok) {
			this.needsPersist = false;
		} else {
			this.log?.warn(`CtrlZTree: flushToDisk failed for ${this.docId}: ${result.error}`);
		}
		return result;
	}

	recordHeadMove(fromHash: string, toHash: string, reason: 'undo' | 'redo' | 'checkout'): void {
		if (!this.hashToNodeId.has(fromHash)) {
			this.log?.warn(`CtrlZTree: recordHeadMove fromHash ${fromHash} is unknown - skipping headMove event`);
			return;
		}
		if (!this.hashToNodeId.has(toHash)) {
			this.log?.warn(`CtrlZTree: recordHeadMove toHash ${toHash} is unknown - skipping headMove event`);
			return;
		}
		const headMoveEvent: HeadMoveEvent = {
			kind: 'headMove',
			schemaVersion: 1,
			seq: this.nextSeq++,
			at: Date.now(),
			txId: this.genTxId(),
			source: 'user',
			from: this.hashToNodeId.get(fromHash)!,
			to: this.hashToNodeId.get(toHash)!,
			reason,
		};
		this.events.push(headMoveEvent);
		this.projection = project(this.docId, this.events);
		this.needsPersist = true; this.log?.debug(`CtrlZTree: headMove events=${this.events.length}`);
	}

	async close(): Promise<void> {
		if (this.needsPersist && this.persistenceService) {
			this.maybeCompact();
			await this.flushToDisk();
		}
		this.queue.clear(this.docId);
		// Release ContentStore memory
		if (this.contentStore) {
			this.contentStore.reset();
		}
	}

	// Compact events when they grow beyond threshold to bound memory usage.
	// Strategy: drop oldest headMove events while preserving edit/init events.
	private maybeCompact(): void {
		const MAX_EVENTS = 5000;
		if (this.events.length <= MAX_EVENTS) { return; }

		const keepFrom = this.events.length - Math.floor(MAX_EVENTS * 0.8);
		const compacted: HistoryEvent[] = [];

		for (let i = 0; i < this.events.length; i++) {
			const e = this.events[i];
			if (e.kind === 'headMove' && i < keepFrom) {
				continue; // Drop old headMove events
			}
			compacted.push(e);
		}

		if (compacted.length < this.events.length) {
			this.log?.info(`CtrlZTree: Compacted events from ${this.events.length} to ${compacted.length}`);
			this.events = compacted;
			this.projection = project(this.docId, this.events);
			this.needsPersist = true;
		}
	}

	private mapHash(hash: string, nodeId: NodeId): void {
		this.hashToNodeId.set(hash, nodeId);
		this.nodeIdToHash.set(nodeId, hash);
	}

	private genTxId(): TxId {
		return `tx-${this.nextTxId++}`;
	}
}
