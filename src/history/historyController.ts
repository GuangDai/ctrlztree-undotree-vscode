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
		return this.queue.enqueue(this.docId, 'commit', async () => {
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
			try {
				const newProjection = project(this.docId, [...this.events, editEvent]);
				this.events.push(editEvent);
				this.projection = newProjection;
			} catch (err: any) {
				this.log?.error(`CtrlZTree: project() failed in commit: ${err?.message}`);
				// Still push event but with stale projection — next operation will re-project
				this.events.push(editEvent);
			}
			this.needsPersist = true; this.log?.debug(`CtrlZTree: commit events=${this.events.length}`);
			this.log?.debug(`CtrlZTree: commit nodeId=${nodeId} seq=${editEvent.seq} bytes=${newContent.length} events=${this.events.length}`);
			return { hash: newHash };
		});
	}

	async undo(): Promise<NavigateResult> {
		return this.queue.enqueue(this.docId, 'undo', async () => {
			const oldHeadHash = this.tree.getHead();
			const parentHash = this.tree.peekUndo();
			if (!parentHash) {
				return { hash: null, content: null };
			}
			const resultHash = this.tree.z();
			if (resultHash) {
				const headMoveEvent: HeadMoveEvent = {
					kind: 'headMove',
					schemaVersion: 1,
					seq: this.nextSeq++,
					at: Date.now(),
					txId: this.genTxId(),
					source: 'user',
					from: this.hashToNodeId.get(oldHeadHash!) ?? 0,
					to: this.hashToNodeId.get(resultHash) ?? 0,
					reason: 'undo',
				};
				this.events.push(headMoveEvent);
				this.projection = project(this.docId, this.events);
		this.needsPersist = true; this.log?.debug(`CtrlZTree: undo events=${this.events.length}`);
			}
			const content = resultHash ? this.tree.getContent(resultHash) : null;
			return { hash: resultHash, content };
		});
	}

	async redo(childHash?: string): Promise<NavigateResult> {
		return this.queue.enqueue(this.docId, 'redo', async () => {
			const oldHeadHash = this.tree.getHead();
			let result: string | string[];
			if (childHash) {
				const success = this.tree.setHead(childHash);
				result = success ? childHash : '';
			} else {
				result = this.tree.y();
			}
			const newHash = typeof result === 'string' ? result : (Array.isArray(result) && result.length > 0 ? result[0] : null);
			if (newHash) {
				const headMoveEvent: HeadMoveEvent = {
					kind: 'headMove',
					schemaVersion: 1,
					seq: this.nextSeq++,
					at: Date.now(),
					txId: this.genTxId(),
					source: 'user',
					from: this.hashToNodeId.get(oldHeadHash!) ?? 0,
					to: this.hashToNodeId.get(newHash) ?? 0,
					reason: 'redo',
				};
				this.events.push(headMoveEvent);
				this.projection = project(this.docId, this.events);
		this.needsPersist = true; this.log?.debug(`CtrlZTree: redo events=${this.events.length}`);
			}
			const content = newHash ? this.tree.getContent(newHash) : null;
			return { hash: newHash, content };
		});
	}

	async checkout(hash: string): Promise<{ success: boolean; content: string | null }> {
		return this.queue.enqueue(this.docId, 'checkout', async () => {
			const oldHeadHash = this.tree.getHead();
			const success = this.tree.setHead(hash);
			if (success) {
				if (!this.hashToNodeId.has(hash)) {
					this.mapHash(hash, this.nextNodeId++);
				}
				const headMoveEvent: HeadMoveEvent = {
					kind: 'headMove',
					schemaVersion: 1,
					seq: this.nextSeq++,
					at: Date.now(),
					txId: this.genTxId(),
					source: 'user',
					from: this.hashToNodeId.get(oldHeadHash!) ?? 0,
					to: this.hashToNodeId.get(hash)!,
					reason: 'checkout',
				};
				this.events.push(headMoveEvent);
				this.projection = project(this.docId, this.events);
		this.needsPersist = true; this.log?.debug(`CtrlZTree: checkout events=${this.events.length}`);
			}
			const content = success ? this.tree.getContent(hash) : null;
			return { success, content };
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

	getNeedsPersist(): boolean {
		return this.needsPersist && this.persistenceService !== undefined;
	}

	async flushToDisk(): Promise<{ ok: true } | { ok: false; error: string }> {
		if (!this.needsPersist || !this.persistenceService) {
			return { ok: true };
		}
		const fingerprint = PersistenceService.computeFingerprint(this.docId);
		const result = await this.persistenceService.saveDocument(
			fingerprint,
			this.events,
			this.projection.lastSeq,
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
			await this.flushToDisk();
		}
		this.queue.clear(this.docId);
	}

	private mapHash(hash: string, nodeId: NodeId): void {
		this.hashToNodeId.set(hash, nodeId);
		this.nodeIdToHash.set(nodeId, hash);
	}

	private genTxId(): TxId {
		return `tx-${this.nextTxId++}`;
	}
}
