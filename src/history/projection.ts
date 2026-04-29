import { DocId, NodeId, EventSeq, ContentHash } from './ids';
import { HistoryEvent, InitEvent, EditEvent, HeadMoveEvent, ArchiveEvent, DeleteEvent, ProtectEvent, RenameEvent } from './events';

export interface NodeView {
	nodeId: NodeId;
	contentHash: ContentHash;
	name?: string;
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

	for (const event of events) {
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
			// merge, prune, summarize, reset are no-ops for now
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

	// Ensure parent has children list if not already
	if (!proj.childrenOf.has(e.parentId)) {
		// Parent might be root created by init
	}

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
	}
}

function handleDelete(proj: Projection, e: DeleteEvent): void {
	for (const id of e.nodeIds) {
		if (e.mode === 'hard') {
			proj.deletedNodes.add(id);
			proj.archivedNodes.delete(id);
			// Remove children references to deleted nodes
			for (const [parent, children] of proj.childrenOf) {
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

function addToContentHashIndex(proj: Projection, hash: ContentHash, nodeId: NodeId): void {
	const list = proj.contentHashIndex.get(hash) ?? [];
	list.push(nodeId);
	proj.contentHashIndex.set(hash, list);
}

function computeBranchTips(proj: Projection): void {
	const tips: NodeId[] = [];
	for (const [id, view] of proj.byId) {
		if (proj.deletedNodes.has(id)) {
			continue;
		}
		const children = proj.childrenOf.get(id) ?? [];
		const hasVisibleChildren = children.some(childId => !proj.deletedNodes.has(childId) && !proj.archivedNodes.has(childId));
		if (!hasVisibleChildren && !proj.archivedNodes.has(id)) {
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
	for (const [id, view] of proj.byId) {
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
