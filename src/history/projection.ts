import { DocId, NodeId, EventSeq, ContentHash } from './ids';
import { HistoryEvent, InitEvent, EditEvent, HeadMoveEvent, ArchiveEvent, DeleteEvent, ProtectEvent, RenameEvent, MergeEvent, PruneEvent, SummarizeEvent, ResetEvent } from './events';

export interface NodeView {
	nodeId: NodeId;
	contentHash: ContentHash;
	name?: string;
	summary?: string;
	protected: boolean;
	createdAt: number;
}

export interface ProjectionStats {
	nodeCount: number;
	branchCount: number;
	archivedCount: number;
	deletedCount: number;
}

export interface ProjectionDiagnostic {
	severity: 'error' | 'warn';
	message: string;
	eventSeq?: EventSeq;
}

export interface Projection {
	docId: DocId;
	rootId: NodeId;
	headId: NodeId;
	byId: Map<NodeId, NodeView>;
	childrenOf: Map<NodeId, NodeId[]>;
	parentOf: Map<NodeId, NodeId | null>;
	branchTips: NodeId[];
	namedNodes: NodeId[];
	protectedNodes: Set<NodeId>;
	archivedNodes: Set<NodeId>;
	deletedNodes: Set<NodeId>;
	contentHashIndex: Map<ContentHash, NodeId[]>;
	lastSeq: EventSeq;
	stats: ProjectionStats;
	diagnostics: ProjectionDiagnostic[];
}

function emptyProjection(docId: DocId): Projection {
	return {
		docId,
		rootId: 0,
		headId: 0,
		byId: new Map(),
		childrenOf: new Map(),
		parentOf: new Map(),
		branchTips: [],
		namedNodes: [],
		protectedNodes: new Set(),
		archivedNodes: new Set(),
		deletedNodes: new Set(),
		contentHashIndex: new Map(),
		lastSeq: -1,
		stats: { nodeCount: 0, branchCount: 0, archivedCount: 0, deletedCount: 0 },
		diagnostics: []
	};
}

export function project(docId: DocId, events: HistoryEvent[]): Projection {
	const proj = emptyProjection(docId);

	if (events.length === 0) {
		return proj;
	}

	proj.lastSeq = events[events.length - 1].seq;

	let prevSeq = -1;
	for (const event of events) {
		// Validate seq monotonic
		if (event.seq <= prevSeq) {
			proj.diagnostics.push({
				severity: 'error',
				message: `Non-monotonic event seq: ${event.seq} after ${prevSeq}`,
				eventSeq: event.seq
			});
		}
		prevSeq = event.seq;

		switch (event.kind) {
			case 'init':
				handleInit(proj, event);
				break;
			case 'edit':
				handleEdit(proj, event);
				break;
			case 'headMove':
				handleHeadMove(proj, event);
				break;
			case 'rename':
				handleRename(proj, event);
				break;
			case 'protect':
				handleProtect(proj, event);
				break;
			case 'archive':
				handleArchive(proj, event);
				break;
			case 'delete':
				handleDelete(proj, event);
				break;
			case 'merge':
				handleMerge(proj, event);
				break;
			case 'prune':
				handlePrune(proj, event);
				break;
			case 'summarize':
				handleSummarize(proj, event);
				break;
			case 'reset':
				handleReset(proj, event);
				break;
		}
	}

	// Compute branch tips: nodes with no surviving children
	computeBranchTips(proj);

	// Compute stats
	proj.stats = {
		nodeCount: proj.byId.size,
		branchCount: proj.branchTips.length,
		archivedCount: proj.archivedNodes.size,
		deletedCount: proj.deletedNodes.size
	};

	// Validate invariants
	validateInvariants(proj);

	return proj;
}

function handleInit(proj: Projection, e: InitEvent): void {
	const view: NodeView = {
		nodeId: e.nodeId,
		contentHash: e.contentHash,
		name: 'Root',
		protected: false,
		createdAt: e.at
	};
	proj.byId.set(e.nodeId, view);
	proj.rootId = e.nodeId;
	proj.headId = e.nodeId;
	proj.parentOf.set(e.nodeId, null);
	proj.childrenOf.set(e.nodeId, []);
	addToContentHashIndex(proj, e.contentHash, e.nodeId);
}

function handleEdit(proj: Projection, e: EditEvent): void {
	if (proj.deletedNodes.has(e.parentId) || proj.deletedNodes.has(e.nodeId)) {
		proj.diagnostics.push({
			severity: 'warn',
			message: `Edit event references deleted node ${e.nodeId} or parent ${e.parentId}`,
			eventSeq: e.seq
		});
		return;
	}

	if (proj.byId.has(e.nodeId)) {
		proj.diagnostics.push({
			severity: 'error',
			message: `Duplicate nodeId ${e.nodeId} in edit event (already exists)`,
			eventSeq: e.seq
		});
		return;
	}

	if (!proj.byId.has(e.parentId) && e.parentId !== proj.rootId) {
		proj.diagnostics.push({
			severity: 'error',
			message: `Edit event parent ${e.parentId} does not exist`,
			eventSeq: e.seq
		});
		return;
	}

	const view: NodeView = {
		nodeId: e.nodeId,
		contentHash: e.contentHash,
		protected: false,
		createdAt: e.at
	};
	proj.byId.set(e.nodeId, view);
	proj.parentOf.set(e.nodeId, e.parentId);

	const children = proj.childrenOf.get(e.parentId) ?? [];
	children.push(e.nodeId);
	proj.childrenOf.set(e.parentId, children);

	addToContentHashIndex(proj, e.contentHash, e.nodeId);
	proj.headId = e.nodeId;
}

function handleHeadMove(proj: Projection, e: HeadMoveEvent): void {
	if (!proj.byId.has(e.to)) {
		proj.diagnostics.push({
			severity: 'error',
			message: `HeadMove to nonexistent node ${e.to}`,
			eventSeq: e.seq
		});
		return;
	}
	if (proj.deletedNodes.has(e.to)) {
		proj.diagnostics.push({
			severity: 'error',
			message: `HeadMove to deleted node ${e.to}`,
			eventSeq: e.seq
		});
		return;
	}
	proj.headId = e.to;
}

function handleRename(proj: Projection, e: RenameEvent): void {
	const view = proj.byId.get(e.nodeId);
	if (view) {
		view.name = e.name;
		if (!proj.namedNodes.includes(e.nodeId)) {
			proj.namedNodes.push(e.nodeId);
		}
	}
}

function handleProtect(proj: Projection, e: ProtectEvent): void {
	if (e.protected) {
		proj.protectedNodes.add(e.nodeId);
	} else {
		proj.protectedNodes.delete(e.nodeId);
	}
}

function handleArchive(proj: Projection, e: ArchiveEvent): void {
	for (const id of e.nodeIds) {
		proj.archivedNodes.add(id);
		// Remove archived node from parent's children list (consistency)
		for (const [, children] of proj.childrenOf) {
			const idx = children.indexOf(id);
			if (idx >= 0) {
				children.splice(idx, 1);
			}
		}
	}
}

function handleDelete(proj: Projection, e: DeleteEvent): void {
	for (const id of e.nodeIds) {
		if (e.mode === 'hard') {
			proj.deletedNodes.add(id);
			proj.archivedNodes.delete(id);
			// Remove children references to deleted nodes
			for (const [, children] of proj.childrenOf) {
				const idx = children.indexOf(id);
				if (idx >= 0) {
					children.splice(idx, 1);
				}
			}
		} else {
			proj.archivedNodes.add(id);
		}
	}
}

function handleMerge(proj: Projection, e: MergeEvent): void {
	// Archive source nodes
	for (const id of e.sourceIds) {
		proj.archivedNodes.add(id);
	}

	// Create result node
	const view: NodeView = {
		nodeId: e.resultId,
		contentHash: e.contentHash,
		protected: false,
		createdAt: e.at
	};
	proj.byId.set(e.resultId, view);
	proj.parentOf.set(e.resultId, e.parentId);

	const children = proj.childrenOf.get(e.parentId) ?? [];
	children.push(e.resultId);
	proj.childrenOf.set(e.parentId, children);

	addToContentHashIndex(proj, e.contentHash, e.resultId);

	// Archive additional source IDs
	for (const id of e.archivedSourceIds) {
		proj.archivedNodes.add(id);
	}
}

function handlePrune(proj: Projection, e: PruneEvent): void {
	for (const id of e.archivedIds) {
		proj.archivedNodes.add(id);
	}
	for (const id of e.deletedIds) {
		proj.deletedNodes.add(id);
		proj.archivedNodes.delete(id);
	}
}

function handleSummarize(proj: Projection, e: SummarizeEvent): void {
	const view = proj.byId.get(e.nodeId);
	if (view) {
		view.summary = e.summary;
	}
}

function handleReset(proj: Projection, e: ResetEvent): void {
	// Clear all state and create new root
	proj.byId.clear();
	proj.childrenOf.clear();
	proj.parentOf.clear();
	proj.branchTips = [];
	proj.namedNodes = [];
	proj.protectedNodes.clear();
	proj.archivedNodes.clear();
	proj.deletedNodes.clear();
	proj.contentHashIndex.clear();

	const view: NodeView = {
		nodeId: e.newRootId,
		contentHash: '',
		protected: false,
		createdAt: e.at
	};
	proj.byId.set(e.newRootId, view);
	proj.rootId = e.newRootId;
	proj.headId = e.newRootId;
	proj.parentOf.set(e.newRootId, null);
	proj.childrenOf.set(e.newRootId, []);
}

function addToContentHashIndex(proj: Projection, hash: ContentHash, nodeId: NodeId): void {
	const list = proj.contentHashIndex.get(hash) ?? [];
	list.push(nodeId);
	proj.contentHashIndex.set(hash, list);
}

function computeBranchTips(proj: Projection): void {
	const tips: NodeId[] = [];
	for (const [id] of proj.byId) {
		if (proj.deletedNodes.has(id) || proj.archivedNodes.has(id)) {
			continue;
		}
		// Nodes whose parent is archived are not true tips (they're in an archived sub-tree)
		const parent = proj.parentOf.get(id);
		if (parent !== undefined && parent !== null && proj.archivedNodes.has(parent)) {
			continue;
		}
		const children = proj.childrenOf.get(id) ?? [];
		const hasVisibleChildren = children.some(childId => !proj.deletedNodes.has(childId) && !proj.archivedNodes.has(childId));
		if (!hasVisibleChildren) {
			tips.push(id);
		}
	}
	proj.branchTips = tips;
}

function validateInvariants(proj: Projection): void {
	const diag = proj.diagnostics;

	// head must exist and not be hard deleted
	if (!proj.byId.has(proj.headId)) {
		diag.push({ severity: 'error', message: `Head node ${proj.headId} does not exist` });
	} else if (proj.deletedNodes.has(proj.headId)) {
		diag.push({ severity: 'error', message: `Head node ${proj.headId} is hard deleted` });
	}

	// root must exist and have no parent
	if (!proj.byId.has(proj.rootId)) {
		diag.push({ severity: 'error', message: `Root node ${proj.rootId} does not exist` });
	} else if (proj.parentOf.get(proj.rootId) !== null && proj.parentOf.get(proj.rootId) !== undefined) {
		diag.push({ severity: 'error', message: `Root node ${proj.rootId} has a parent` });
	}

	// Every visible non-root node must have a parent
	for (const [id] of proj.byId) {
		if (proj.deletedNodes.has(id)) {
			continue;
		}
		if (id === proj.rootId) {
			continue;
		}
		const parent = proj.parentOf.get(id);
		if (parent === undefined || parent === null) {
			diag.push({ severity: 'error', message: `Node ${id} has no parent in parentOf` });
		} else if (!proj.byId.has(parent) && !proj.deletedNodes.has(parent)) {
			diag.push({ severity: 'warn', message: `Node ${id} parent ${parent} does not exist` });
		}
	}

	// childrenOf and parentOf consistency
	for (const [parentId, children] of proj.childrenOf) {
		for (const childId of children) {
			const actualParent = proj.parentOf.get(childId);
			if (actualParent !== parentId) {
				diag.push({
					severity: 'error',
					message: `Consistency: parentOf(${childId})=${actualParent} but childrenOf(${parentId}) contains ${childId}`
				});
			}
		}
	}
}
