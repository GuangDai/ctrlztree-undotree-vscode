import { CtrlZTree, TreeNode } from '../model/ctrlZTree';
import { HistoryEvent, InitEvent, EditEvent, HeadMoveEvent } from './events';
import { NodeId, EventSeq, TxId } from './ids';

export interface MigrationResult {
	events: HistoryEvent[];
	warnings: string[];
}

export function migrateCtrlZTreeToEvents(tree: CtrlZTree): MigrationResult {
	const events: HistoryEvent[] = [];
	const warnings: string[] = [];
	const nodeHashToId = new Map<string, NodeId>();
	let nextNodeId: NodeId = 0;
	let nextSeq: EventSeq = 0;
	let nextTxId = 0;

	function txId(): TxId {
		return `migrate-${nextTxId++}`;
	}

	const allNodes = tree.getAllNodes();
	const rootHash = tree.getInternalRootHash();
	const initialSnapshotHash = tree.getInitialSnapshotHash();
	const headHash = tree.getHead();

	// Assign NodeIds to all existing nodes
	for (const hash of allNodes.keys()) {
		nodeHashToId.set(hash, nextNodeId++);
	}

	// Create InitEvent from the internal root
	const initNodeId = nodeHashToId.get(rootHash) ?? 0;
	const initContent = tree.getContent(rootHash);
	const initEvent: InitEvent = {
		kind: 'init',
		schemaVersion: 1,
		seq: nextSeq++,
		at: Date.now(),
		txId: txId(),
		source: 'migration',
		nodeId: initNodeId,
		contentRef: { kind: 'snapshot', bytes: Buffer.byteLength(initContent, 'utf8') },
		contentHash: rootHash,
		isNonEmpty: initContent.length > 0,
		fileSig: { mtime: 0, size: initContent.length }
	};
	events.push(initEvent);

	// Find the initial snapshot (first content node after init root)
	// If initialSnapshotHash differs from root, create it as first edit
	if (initialSnapshotHash !== rootHash && initialSnapshotHash !== null) {
		const snapId = nodeHashToId.get(initialSnapshotHash);
		if (snapId !== undefined) {
			const snapContent = tree.getContent(initialSnapshotHash);
			const initSnapEvent: EditEvent = {
				kind: 'edit',
				schemaVersion: 1,
				seq: nextSeq++,
				at: Date.now(),
				txId: txId(),
				source: 'migration',
				nodeId: snapId,
				parentId: initNodeId,
				contentRef: { kind: 'snapshot', bytes: Buffer.byteLength(snapContent, 'utf8') },
				contentHash: initialSnapshotHash,
				isNonEmpty: snapContent.length > 0,
				stats: { contentBytes: snapContent.length, diffBytes: 0, lineCount: snapContent.split(/\r?\n/).length }
			};
			events.push(initSnapEvent);
		}
	}

	// Create EditEvents for remaining nodes (in parent-first order for seq continuity)
	const processed = new Set<NodeId>([initNodeId]);
	if (initialSnapshotHash !== rootHash) {
		const snapId = nodeHashToId.get(initialSnapshotHash);
		if (snapId !== undefined) {
			processed.add(snapId);
		}
	}

	// BFS/DFS traversal from root to assign sequential events
	const queue: string[] = [rootHash];
	if (initialSnapshotHash !== rootHash) {
		queue.push(initialSnapshotHash);
	}

	while (queue.length > 0) {
		const currentHash = queue.shift()!;
		const currentNode = allNodes.get(currentHash);
		if (!currentNode) {
			continue;
		}

		for (const childHash of currentNode.children) {
			if (processed.has(nodeHashToId.get(childHash)!)) {
				continue;
			}

			const childNode = allNodes.get(childHash);
			if (!childNode) {
				continue;
			}

			const childId = nodeHashToId.get(childHash)!;
			const parentId = nodeHashToId.get(currentHash)!;
			const childContent = tree.getContent(childHash);
			const diffStr = childNode.diff ?? '';

			const editEvent: EditEvent = {
				kind: 'edit',
				schemaVersion: 1,
				seq: nextSeq++,
				at: childNode.timestamp,
				txId: txId(),
				source: 'migration',
				nodeId: childId,
				parentId: parentId,
				contentRef: { kind: 'inline-diff', nodeId: childId, bytes: Buffer.byteLength(diffStr, 'utf8') },
				contentHash: childHash,
				isNonEmpty: childContent.length > 0,
				cursor: childNode.cursorPosition ? { line: childNode.cursorPosition.line, character: childNode.cursorPosition.character } : undefined,
				stats: { contentBytes: childContent.length, diffBytes: Buffer.byteLength(diffStr, 'utf8'), lineCount: childContent.split(/\r?\n/).length }
			};
			events.push(editEvent);
			processed.add(childId);
			queue.push(childHash);
		}
	}

	// Create HeadMoveEvent if head differs from last edit
	if (headHash && headHash !== rootHash) {
		const headId = nodeHashToId.get(headHash);
		if (headId !== undefined && !processed.has(headId)) {
			warnings.push(`Head node ${headHash} not in event chain`);
		}

		if (headId !== undefined && events.length > 0) {
			const lastEdit = events[events.length - 1];
			const lastNodeId = 'nodeId' in lastEdit ? (lastEdit as EditEvent).nodeId : initNodeId;

			if (headId !== lastNodeId) {
				const headMoveEvent: HeadMoveEvent = {
					kind: 'headMove',
					schemaVersion: 1,
					seq: nextSeq++,
					at: Date.now(),
					txId: txId(),
					source: 'migration',
					from: lastNodeId,
					to: headId,
					reason: 'checkout'
				};
				events.push(headMoveEvent);
			}
		}
	}

	return { events, warnings };
}
