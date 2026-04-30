import { NodeId, EventSeq } from './ids';
import { Projection } from './projection';
import { MergeEvent } from './events';

export interface MergePlan {
	sourceIds: NodeId[];
	targetParentId: NodeId;
	estimatedBytesFreed: number;
	warnings: string[];
	valid: boolean;
}

export interface MergeResult {
	resultNodeId: NodeId;
	resultContentHash: string;
	mergeEvent: MergeEvent;
	sourceIds: NodeId[];
}

export function generateMergePlan(
	projection: Projection,
	sourceIds: NodeId[]
): MergePlan {
	const warnings: string[] = [];
	const { byId, parentOf, childrenOf, headId, deletedNodes, rootId } = projection;

	if (sourceIds.length === 0) {
		return { sourceIds, targetParentId: 0, estimatedBytesFreed: 0, warnings: ['No source IDs provided'], valid: false };
	}

	// Validate all sourceIds exist and are not deleted
	for (const id of sourceIds) {
		if (!byId.has(id)) {
			return { sourceIds, targetParentId: 0, estimatedBytesFreed: 0, warnings: [`Node ${id} does not exist`], valid: false };
		}
		if (deletedNodes.has(id)) {
			return { sourceIds, targetParentId: 0, estimatedBytesFreed: 0, warnings: [`Node ${id} is hard deleted`], valid: false };
		}
	}

	// Cannot merge root
	if (sourceIds.includes(rootId)) {
		return { sourceIds, targetParentId: 0, estimatedBytesFreed: 0, warnings: ['Cannot merge root node'], valid: false };
	}

	// Cannot merge head
	if (sourceIds.includes(headId)) {
		warnings.push('Merging head node may cause issues');
	}

	// Validate linear chain: all nodes in same parent chain
	const parents = new Set<NodeId>();
	for (const id of sourceIds) {
		const parent = parentOf.get(id);
		if (parent === undefined || parent === null) {
			return { sourceIds, targetParentId: 0, estimatedBytesFreed: 0, warnings: [`Node ${id} has no parent`], valid: false };
		}
		parents.add(parent);
	}

	// For linear squash, all nodes should form a chain: each node is child of the previous
	let isLinear = true;
	if (sourceIds.length > 1) {
		const sorted = [...sourceIds].sort((a, b) => {
			const va = byId.get(a);
			const vb = byId.get(b);
			return (va?.createdAt ?? 0) - (vb?.createdAt ?? 0);
		});

		for (let i = 1; i < sorted.length; i++) {
			const current = sorted[i];
			const prev = sorted[i - 1];
			const currentParent = parentOf.get(current);
			if (currentParent !== prev) {
				isLinear = false;
				// Check if they share a common parent (branch merge)
				if (currentParent !== parentOf.get(prev)) {
					warnings.push(`Non-linear merge: node ${current} parent is ${currentParent}, not ${prev}`);
				}
			}
		}
	} else {
		isLinear = true;
	}

	if (!isLinear) {
		warnings.push('Merge plan involves non-linear chain - requires confirmation');
	}

	// Check that last node's children are not affected
	const lastNodeChildren = childrenOf.get(sourceIds[sourceIds.length - 1]) ?? [];
	for (const childId of lastNodeChildren) {
		if (!sourceIds.includes(childId) && !deletedNodes.has(childId)) {
			warnings.push(`Child ${childId} of merged nodes will need re-parenting`);
		}
	}

	// Target parent is the first node's parent
	const targetParentId = parentOf.get(sourceIds[0])!;

	// Estimated bytes freed (approximate: each node ~1KB)
	const estimatedBytesFreed = sourceIds.length * 1024;

	return {
		sourceIds,
		targetParentId,
		estimatedBytesFreed,
		warnings,
		valid: true
	};
}

export function executeMerge(
	plan: MergePlan,
	projection: Projection,
	resultContent: string,
	resultNodeId: NodeId,
	baseSeq: EventSeq,
): MergeResult {
	const contentHash = ''; // Will be computed by the caller via sha256

	const mergeEvent: MergeEvent = {
		kind: 'merge',
		schemaVersion: 1,
		seq: baseSeq + 1,
		at: Date.now(),
		txId: `tx-merge-${resultNodeId}`,
		source: 'user',
		resultId: resultNodeId,
		sourceIds: plan.sourceIds,
		parentId: plan.targetParentId,
		contentRef: { kind: 'snapshot', nodeId: resultNodeId, bytes: Buffer.byteLength(resultContent, 'utf8') },
		contentHash,
		archivedSourceIds: plan.sourceIds,
		reason: 'User requested linear chain merge',
	};

	return {
		resultNodeId,
		resultContentHash: contentHash,
		mergeEvent,
		sourceIds: plan.sourceIds,
	};
}
