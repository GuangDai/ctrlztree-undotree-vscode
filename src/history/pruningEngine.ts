import { NodeId } from './ids';
import { Projection } from './projection';

export interface PrunePlan {
	keep: NodeId[];
	archive: NodeId[];
	delete: NodeId[];
	estimatedBytesFreed: number;
	warnings: string[];
	requiresConfirmation: boolean;
}

export interface PruningPolicy {
	maxNodes: number;
	keepBranchTips: number;
	archiveBeforeDelete: boolean;
	recentWindowMs: number;
}

export const DEFAULT_PRUNING_POLICY: PruningPolicy = {
	maxNodes: 1000,
	keepBranchTips: 20,
	archiveBeforeDelete: true,
	recentWindowMs: 600000, // 10 minutes
};

export function generatePrunePlan(
	projection: Projection,
	policy: PruningPolicy = DEFAULT_PRUNING_POLICY
): PrunePlan {
	const { byId, headId, rootId, parentOf, childrenOf, branchTips, protectedNodes, archivedNodes, deletedNodes, namedNodes } = projection;

	// Early return when not exceeding threshold
	if (byId.size <= policy.maxNodes) {
		const keep = Array.from(byId.keys())
			.filter(id => !deletedNodes.has(id))
			.sort((a, b) => a - b);
		return {
			keep,
			archive: [],
			delete: [],
			estimatedBytesFreed: 0,
			warnings: [],
			requiresConfirmation: false
		};
	}

	const keep = new Set<NodeId>();
	const archive = new Set<NodeId>();
	const hardDelete = new Set<NodeId>();
	const warnings: string[] = [];

	// Priority 1: Head-to-root path (non-negotiable)
	const headPath = new Set<NodeId>();
	let cursor: NodeId | null = headId;
	while (cursor !== null) {
		headPath.add(cursor);
		keep.add(cursor);
		const parent = parentOf.get(cursor);
		cursor = parent ?? null;
	}

	// Priority 2: Protected nodes and their paths
	for (const id of protectedNodes) {
		keep.add(id);
		let c: NodeId | null = id;
		while (c !== null) {
			keep.add(c);
			const parent = parentOf.get(c);
			c = parent ?? null;
		}
	}

	// Priority 2b: Named nodes and their paths
	for (const id of namedNodes) {
		if (!keep.has(id)) {
			keep.add(id);
			let c: NodeId | null = id;
			while (c !== null) {
				keep.add(c);
				const parent = parentOf.get(c);
				c = parent ?? null;
			}
		}
	}

	// Priority 3: Most recent branch tips (also preserve their root paths)
	const sortedBranchTips = [...branchTips]
		.filter(id => !keep.has(id) && !deletedNodes.has(id))
		.sort((a, b) => {
			const viewA = byId.get(a);
			const viewB = byId.get(b);
			return (viewB?.createdAt ?? 0) - (viewA?.createdAt ?? 0);
		});

	for (let i = 0; i < Math.min(policy.keepBranchTips, sortedBranchTips.length); i++) {
		const tipId = sortedBranchTips[i];
		keep.add(tipId);
		// Also keep the path to root for each kept tip
		let c: NodeId | null = parentOf.get(tipId) ?? null;
		while (c !== null) {
			keep.add(c);
			c = parentOf.get(c) ?? null;
		}
	}

	// Priority 4: Recent time window nodes
	const now = Date.now();
	for (const [id, view] of byId) {
		if (keep.has(id) || deletedNodes.has(id)) {
			continue;
		}
		if (now - view.createdAt < policy.recentWindowMs) {
			keep.add(id);
		}
	}

	// Remaining nodes: archive or delete
	for (const [id, view] of byId) {
		if (keep.has(id) || deletedNodes.has(id)) {
			continue;
		}
		if (archivedNodes.has(id)) {
			// Already archived, candidate for hard delete
			if (policy.archiveBeforeDelete) {
				hardDelete.add(id);
			} else {
				warnings.push(`Node ${id} is archived but archiveBeforeDelete is off - skipping`);
			}
		} else {
			archive.add(id);
		}
	}

	// Check against max nodes
	if (keep.size > policy.maxNodes) {
		warnings.push(`keep set exceeds maxNodes: ${keep.size} > ${policy.maxNodes}`);
	}

	const requiresConfirmation = hardDelete.size > 0 || warnings.length > 0;

	return {
		keep: Array.from(keep).sort((a, b) => a - b),
		archive: Array.from(archive).sort((a, b) => a - b),
		delete: Array.from(hardDelete).sort((a, b) => a - b),
		estimatedBytesFreed: hardDelete.size * 1024 + archive.size * 256,
		warnings,
		requiresConfirmation
	};
}
