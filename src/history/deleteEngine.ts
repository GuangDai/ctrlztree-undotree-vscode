import { NodeId } from './ids';
import { Projection } from './projection';

export type DeleteMode = 'soft' | 'hard';

export interface DeletePlan {
	targetIds: NodeId[];
	mode: DeleteMode;
	sharedAncestorId?: NodeId;
	estimatedBytesFreed: number;
	warnings: string[];
	valid: boolean;
	requiresConfirmation: boolean;
}

export function generateDeletePlan(
	projection: Projection,
	targetIds: NodeId[],
	mode: DeleteMode = 'soft'
): DeletePlan {
	const warnings: string[] = [];
	const { byId, parentOf, childrenOf, headId, rootId, protectedNodes, archivedNodes } = projection;

	// Validate targets
	for (const id of targetIds) {
		if (!byId.has(id)) {
			return { targetIds, mode, estimatedBytesFreed: 0, warnings: [`Node ${id} does not exist`], valid: false, requiresConfirmation: false };
		}
	}

	// Cannot delete root
	if (targetIds.includes(rootId)) {
		return { targetIds, mode, estimatedBytesFreed: 0, warnings: ['Cannot delete root node'], valid: false, requiresConfirmation: false };
	}

	// Cannot delete head
	if (targetIds.includes(headId)) {
		return { targetIds, mode, estimatedBytesFreed: 0, warnings: ['Cannot delete current head node - checkout to another node first'], valid: false, requiresConfirmation: false };
	}

	// Check protected nodes
	for (const id of targetIds) {
		if (protectedNodes.has(id)) {
			warnings.push(`Node ${id} is protected - requires confirmation to delete`);
		}
	}

	// Check for children that would become orphaned
	for (const id of targetIds) {
		const nodeChildren = childrenOf.get(id) ?? [];
		for (const childId of nodeChildren) {
			if (!targetIds.includes(childId)) {
				warnings.push(`Deleting node ${id} will orphan child ${childId}`);
			}
		}
	}

	// For branch delete, find shared ancestor (lowest common ancestor not being deleted)
	let sharedAncestorId: NodeId | undefined;
	if (targetIds.length > 1) {
		const paths = targetIds.map(id => {
			const path: NodeId[] = [];
			let cursor: NodeId | null = id;
			while (cursor !== null) {
				path.push(cursor);
				cursor = parentOf.get(cursor) ?? null;
			}
			return path;
		});

		// Find the lowest common ancestor starting from the first target upward
		const rootPath = paths[0];
		for (const ancestor of rootPath) {
			if (paths.every(p => p.includes(ancestor))) {
				// This is a common ancestor; if it's in targetIds, continue up
				if (!targetIds.includes(ancestor)) {
					sharedAncestorId = ancestor;
					break;
				}
			}
		}
	}

	// Hard delete requires confirmation
	const requiresConfirmation = mode === 'hard'
		|| warnings.some(w => w.includes('protected'))
		|| warnings.some(w => w.includes('orphan'));

	// For soft delete (archive), only confirm if protected or orphan warnings
	// For hard delete, always confirm
	const finalConfirmation = mode === 'hard' ? true : requiresConfirmation;

	const estimatedBytesFreed = targetIds.length * 1024;

	return {
		targetIds,
		mode,
		sharedAncestorId,
		estimatedBytesFreed,
		warnings,
		valid: true,
		requiresConfirmation: finalConfirmation
	};
}
