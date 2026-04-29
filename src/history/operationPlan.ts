import { NodeId, EventSeq, DocId } from './ids';
import { Projection } from './projection';

export interface OperationPreview {
	affectedNodes: NodeId[];
	estimatedBytesFreed: number;
	restorationPath: string;
}

export interface HistoryOperationPlan {
	version: '1';
	docId: DocId;
	baseSeq: EventSeq;
	operation: 'merge' | 'delete' | 'archive' | 'prune' | 'rename' | 'summarize';
	targetIds: NodeId[];
	preview: OperationPreview;
	risk: 'low' | 'medium' | 'high';
	requiresConfirmation: boolean;
	generatedBy: 'user' | 'system' | 'ai';
	warnings: string[];
}

export interface PlanValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

export function validateOperationPlan(
	plan: HistoryOperationPlan,
	projection: Projection
): PlanValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (plan.version !== '1') {
		errors.push('Unsupported plan version');
		return { valid: false, errors, warnings };
	}

	// Check baseSeq is current
	if (plan.baseSeq !== projection.lastSeq) {
		errors.push(`Stale baseSeq: plan has ${plan.baseSeq}, current is ${projection.lastSeq}`);
	}

	// Check targetIds exist and are not hard deleted
	for (const id of plan.targetIds) {
		if (!projection.byId.has(id)) {
			errors.push(`Target node ${id} does not exist`);
		} else if (projection.deletedNodes.has(id)) {
			errors.push(`Target node ${id} is hard deleted`);
		}
	}

	// Check head protection
	if (plan.operation === 'delete' || plan.operation === 'archive') {
		if (plan.targetIds.includes(projection.headId)) {
			errors.push('Cannot delete/archive the current head node');
		}
	}

	// Check protected nodes
	for (const id of plan.targetIds) {
		if (projection.protectedNodes.has(id)) {
			warnings.push(`Node ${id} is protected - requires confirmation`);
		}
	}

	// Check root
	if (plan.targetIds.includes(projection.rootId)) {
		errors.push('Cannot operate on root node');
	}

	// For delete operations, check for dangling children
	if (plan.operation === 'delete') {
		for (const id of plan.targetIds) {
			const children = projection.childrenOf.get(id) ?? [];
			for (const childId of children) {
				if (!plan.targetIds.includes(childId) && !projection.deletedNodes.has(childId)) {
					warnings.push(`Deleting node ${id} will leave child ${childId} orphaned`);
				}
			}
		}
	}

	// Risk-based validation
	if (plan.risk === 'high' && !plan.requiresConfirmation) {
		errors.push('High-risk operations must require confirmation');
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings
	};
}
