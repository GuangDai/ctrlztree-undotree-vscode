import { DocId, NodeId, EventSeq, TxId, Cursor } from './ids';
import { HistoryEvent, InitEvent, EditEvent, HeadMoveEvent, ContentRef } from './events';
import { Projection, project } from './projection';
import { CtrlZTree } from '../model/ctrlZTree';
import { DocumentTaskQueue } from '../concurrency/documentTaskQueue';
import { MemoryContentStore, SnapshotPolicy } from './contentStore';
import { PersistenceService } from '../security/persistenceService';
import { Logger } from '../utils/logger';
import * as crypto from 'crypto';

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

	async commit(content: string, cursor?: { line: number; character: number }): Promise<CommitResult> {
		return this.queue.enqueue(this.docId, 'commit', async (token) => {
			if (token.cancelled) { throw new Error(`Commit cancelled: ${token.cancelReason}`); }
			const oldContent = this.tree.getContent();
			const cursorPos: Cursor | undefined = cursor ? { line: cursor.line, character: cursor.character } : undefined;
			const savedHead = this.tree.getHead();
			const savedNextNodeId = this.nextNodeId;
			const savedSeq = this.nextSeq;
			const newHash = this.tree.set(content, cursorPos as any);

			if (newHash === savedHead && oldContent === content) {
				// Content unchanged — but cursor may have moved. Record headMove if so.
				if (cursorPos) {
					const headNodeId = this.hashToNodeId.get(newHash);
					if (headNodeId !== undefined) {
						const headMoveEvent: HeadMoveEvent = {
							kind: 'headMove',
							schemaVersion: 1,
							seq: this.nextSeq++,
							at: Date.now(),
							txId: this.genTxId(),
							source: 'user',
							from: headNodeId,
							to: headNodeId,
							reason: 'checkout',
							cursor: cursorPos,
						};
						this.events.push(headMoveEvent);
						this.projection = project(this.docId, this.events);
						this.needsPersist = true;
					}
				}
				return { hash: newHash };
			}

			if (!this.hashToNodeId.has(newHash)) {
				this.mapHash(newHash, this.nextNodeId++);
			}
			const nodeId = this.hashToNodeId.get(newHash)!;
			const parentHash = this.tree.getAllNodes().get(newHash)?.parent;
			let parentId: NodeId = 0;
			if (parentHash) {
				if (!this.hashToNodeId.has(parentHash)) {
					this.mapHash(parentHash, this.nextNodeId++);
				}
				parentId = this.hashToNodeId.get(parentHash)!;
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
				// Rollback: remove the bad event, restore tree + counters, re-project
				this.log?.error(`CtrlZTree: project() failed in commit, rolling back: ${err?.message}`);
				this.events.pop();
				// Revert tree head if changed by this commit
				if (savedHead && savedHead !== this.tree.getHead()) {
					this.tree.setHead(savedHead);
				}
				// Revert ID counters
				this.nextNodeId = savedNextNodeId;
				this.nextSeq = savedSeq;
				// Revert hash mappings added by this commit
				if (this.hashToNodeId.has(newHash)) {
					const nid = this.hashToNodeId.get(newHash)!;
					if (nid >= savedNextNodeId) {
						this.hashToNodeId.delete(newHash);
						this.nodeIdToHash.delete(nid);
					}
				}
				// Clean up orphaned content store entry
				if (this.contentStore && nodeId >= savedNextNodeId) {
					this.contentStore.clearCacheFor(nodeId);
				}
				this.projection = project(this.docId, this.events);
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
			if (!this.hashToNodeId.has(this.tree.getHead()!)) {
				const oldHash = this.tree.getHead()!;
				this.mapHash(oldHash, this.nextNodeId++);
			}
			const oldNodeId = this.hashToNodeId.get(this.tree.getHead()!)!;
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
			if (parentHash) {
				this.tree.z();
			} else {
				// peekUndo() returned null -- either we're at initialSnapshot boundary
				// or at root. In either case, sync legacy tree head to match projection.
				// newNodeId is a valid non-null projection nodeId (guarded above).
				const syncHash = this.nodeIdToHash.get(newNodeId);
				if (syncHash) {
					this.tree.setHead(syncHash);
				} else {
					// Cannot sync legacy tree — projection and legacy tree are desynced.
					this.log?.error('CtrlZTree: undo cannot sync legacy tree — projection/legacy desync');
					return { hash: null, content: null };
				}
			}
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
				// Resolve child by hash to nodeId; lazy-map if hash is unknown
				let targetNodeId = this.hashToNodeId.get(childHash);
				if (targetNodeId === undefined) {
					// Hash exists in legacy tree but not yet mapped — map it now
					if (this.tree.getAllNodes().has(childHash)) {
						this.mapHash(childHash, this.nextNodeId++);
						targetNodeId = this.hashToNodeId.get(childHash)!;
					}
				}
				if (targetNodeId === undefined || !visibleChildren.includes(targetNodeId)) {
					// Try fallback via projection's contentHashIndex
					const contentHash = childHash.split('#')[0]; // strip disambiguator suffix
					const candidateIds = proj.contentHashIndex.get(contentHash) ?? [];
					const visibleCandidate = candidateIds.find(id => visibleChildren.includes(id));
					if (visibleCandidate !== undefined) {
						targetNodeId = visibleCandidate;
					} else {
						this.log?.warn(`CtrlZTree: redo child ${childHash.substring(0, 8)} not in visible children`);
						return { hash: null, content: null };
					}
				}
				targetId = targetNodeId!;
			} else {
				targetId = visibleChildren[0]; // First visible child
			}

			const oldNodeId = this.hashToNodeId.get(this.tree.getHead()!) ?? currentHead;

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
			// Sync legacy tree head -- use the hash from nodeId mapping, not raw childHash
			// (childHash may not match the targetId resolved via contentHashIndex fallback)
			const syncHash = this.nodeIdToHash.get(targetId);
			if (syncHash) {
				this.tree.setHead(syncHash);
			} else if (childHash) {
				this.tree.setHead(childHash);
			} else {
				this.tree.y();
			}
			const newHash = this.tree.getHead()!;
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
			// Reject navigation to root node (always empty content)
			if (finalTargetId === proj.rootId) {
				return { success: false, content: null };
			}

			const oldNodeId = this.hashToNodeId.get(this.tree.getHead()!) ?? proj.headId;

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
			if (!this.tree.setHead(hash)) {
				return { success: false, content: null };
			}
			this.needsPersist = true;
			return { success: true, content: this.tree.getContent(hash) };
		});
	}

	getProjection(): Projection {
		return this.projection;
	}

	// Set head directly in the legacy tree and re-project without emitting
	// a headMove event. Used for rollbacks to avoid duplicate events.
	setHeadDirectly(hash: string): void {
		this.tree.setHead(hash);
		this.projection = project(this.docId, this.events);
	}

	getTree(): CtrlZTree {
		return this.tree;
	}

	getHead(): string | null {
		return this.tree.getHead();
	}

	getNodeIdByHash(hash: string): number | undefined {
		return this.hashToNodeId.get(hash);
	}

	getHashByNodeId(nodeId: number): string | undefined {
		return this.nodeIdToHash.get(nodeId);
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
		// Store merge result snapshot so resolve() works
		if (this.contentStore) {
			this.contentStore.putSnapshot(resultNodeId, resultContent);
		}
		// Also set content in legacy tree for consistency
		const parentHash = this.tree.getAllNodes().get(this.tree.getHead()!)?.parent;
		if (parentHash) {
			this.tree.setHead(parentHash);
		}
		const newHash = this.tree.set(resultContent);
		// Map the merge result hash to its nodeId so checkout/navigate works
		this.mapHash(newHash, resultNodeId);
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

	/**
	 * Apply AI-provided name/summary updates to nodes.
	 * Pure core logic — no AI or VS Code deps.
	 * Validates nodeIds against the projection, emits RenameEvent/SummarizeEvent.
	 */
	applyAiNodeUpdates(
		updates: Array<{ nodeId: NodeId; name?: string; summary?: string }>,
		aiProvenance?: { provider: string; model: string; confidence?: number }
	): { applied: number; skipped: number } {
		const proj = this.projection;
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
					seq: this.nextSeq++,
					at: Date.now(),
					txId: this.genTxId(),
					source: 'ai-plan',
					nodeId: update.nodeId,
					name: update.name.trim(),
					ai: aiProvenance ? { provider: aiProvenance.provider, model: aiProvenance.model, confidence: aiProvenance.confidence } : undefined,
				};
				this.events.push(renameEvent);
				applied++;
			}
			if (update.summary !== undefined && update.summary.trim().length > 0) {
				const summarizeEvent: import('./events').SummarizeEvent = {
					kind: 'summarize',
					schemaVersion: 1,
					seq: this.nextSeq++,
					at: Date.now(),
					txId: this.genTxId(),
					source: 'ai-plan',
					nodeId: update.nodeId,
					summary: update.summary.trim(),
					ai: aiProvenance ? { provider: aiProvenance.provider, model: aiProvenance.model, confidence: aiProvenance.confidence } : undefined,
				};
				this.events.push(summarizeEvent);
				applied++;
			}
		}

		if (applied > 0) {
			this.projection = project(this.docId, this.events);
			this.needsPersist = true;
			this.log?.debug(`CtrlZTree: applyAiNodeUpdates applied=${applied} skipped=${skipped} events=${this.events.length}`);
		}

		return { applied, skipped };
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
		// Re-map the internal root hash (always nodeId 0)
		controller.mapHash(controller.tree.getInternalRootHash(), 0);
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
			// Rebuild legacy tree from persisted content entries so that undo/redo
			// and content resolution work correctly after restore.
			// Walk the projection from root to head in topological order,
			// resolve each node's content via ContentStore, and rebuild the tree.
			if (controller.contentStore) {
				const proj = controller.projection;
				// Collect nodes in topological order (root to head via parent chain)
				const headPath: number[] = [];
				let c: number | null = proj.headId;
				while (c !== null) {
					headPath.push(c);
					c = proj.parentOf.get(c) ?? null;
				}
				headPath.reverse(); // root-first
				// Replay: for each node, resolve content and set it in the tree
				// Skip node 0 (true empty root)
				for (const nodeId of headPath) {
					if (nodeId === proj.rootId) { continue; }
					const nodeContent = controller.contentStore.resolve(nodeId, proj);
					if (nodeContent !== null) {
						const nodeView = proj.byId.get(nodeId);
						controller.tree.set(nodeContent, undefined, nodeView?.createdAt);
					}
				}
			}
			// Rebuild hashToNodeId mapping.
			// The legacy tree was rebuilt above, so tree.getAllNodes() now contains
			// hashes for all persisted nodes. Map hashes to nodeIds via contentHash.
			for (const [hash, node] of controller.tree.getAllNodes()) {
				const internalRoot = controller.tree.getInternalRootHash();
				if (hash === internalRoot) { continue; }
				const content = controller.tree.getContent(hash);
				const contentHash = sha256(content);
				const candidateIds = controller.projection.contentHashIndex.get(contentHash) ?? [];
				if (candidateIds.length === 0) { continue; }
				// Prefer candidate matching the parent chain when possible
				let matchedId: number | undefined;
				if (node.parent) {
					const parentNodeId = controller.hashToNodeId.get(node.parent);
					if (parentNodeId !== undefined) {
						for (const cid of candidateIds) {
							if (controller.projection.parentOf.get(cid) === parentNodeId) {
								matchedId = cid;
								break;
							}
						}
					}
				}
				// Prefer unmapped candidate
				if (matchedId === undefined) {
					for (const cid of candidateIds) {
						if (!controller.nodeIdToHash.has(cid)) {
							matchedId = cid;
							break;
						}
					}
				}
				// Fallback: first candidate
				if (matchedId === undefined) {
					matchedId = candidateIds[0];
				}
				controller.mapHash(hash, matchedId);
			}
		controller.needsPersist = false; // Just loaded from disk
		controller.log?.info(`CtrlZTree: Restored ${events.length} events${contentEntries ? ` + ${contentEntries.length} snapshots` : ''} from persistence`);
		return controller;
	}

	async flushToDisk(): Promise<{ ok: true } | { ok: false; error: string }> {
		if (!this.needsPersist || !this.persistenceService) {
			return { ok: true };
		}
		// Serialize through the task queue to avoid TOCTOU with concurrent commit/undo/redo
		const result = await this.queue.enqueue(this.docId, 'flush', async (token) => {
			if (token.cancelled) { return { ok: false as const, error: 'Flush cancelled' }; }
			if (!this.needsPersist || !this.persistenceService) {
				return { ok: true as const };
			}
			const fingerprint = PersistenceService.computeFingerprint(this.docId);
			// Collect ContentStore snapshots for persistence.
			// Resolve content for ALL nodes on the head-to-root path, not just snapshots.
			// Inline-diff nodes need content persisted too for correct restore.
			let contentEntries: Array<{ nodeId: number; content: string }> | undefined;
			if (this.contentStore) {
				const proj = this.projection;
				contentEntries = [];
				let cursor: number | null = proj.headId;
				let depth = 0;
				const maxDepth = 64;
				while (cursor !== null && depth < maxDepth) {
					const content = this.contentStore.resolve(cursor, proj);
					if (content !== null) {
						contentEntries.push({ nodeId: cursor, content });
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
			});
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
		// Sync legacy tree head so dual stores stay consistent
		if (this.tree.getAllNodes().has(toHash)) {
			this.tree.setHead(toHash);
		}
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
			// Clean up orphan hash-to-nodeId mappings (nodeIds no longer referenced in any event)
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
			for (const [nodeId, hash] of new Map(this.nodeIdToHash)) {
				if (!referencedIds.has(nodeId)) {
					this.nodeIdToHash.delete(nodeId);
					this.hashToNodeId.delete(hash);
				}
			}
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
