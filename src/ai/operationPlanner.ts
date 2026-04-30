import { UnifiedAiResponse, NodeUpdate, OperationPlanItem } from './types';
import { Projection } from '../history/projection';
import { NodeId, EventSeq } from '../history/ids';

export interface AiValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
	staleBaseSeq: boolean;
	hasDestructivePlan: boolean;
	requiresConfirmation: boolean;
}

export function validateAiResponse(
	response: unknown,
	projection: Projection
): AiValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	// 1. Schema check
	if (!response || typeof response !== 'object') {
		return { valid: false, errors: ['Response is not an object'], warnings: [], staleBaseSeq: false, hasDestructivePlan: false, requiresConfirmation: false };
	}

	const r = response as Record<string, unknown>;

	if (r.version !== '1') {
		errors.push(`Unsupported response version: ${r.version}`);
	}

	if (!Array.isArray(r.nodeUpdates)) {
		errors.push('nodeUpdates is not an array');
	}

	if (!Array.isArray(r.operationPlan)) {
		errors.push('operationPlan is not an array');
	}

	if (!Array.isArray(r.warnings)) {
		errors.push('warnings is not an array');
	}

	// 2. baseSeq check
	const baseSeq = r.baseSeq as number;
	if (typeof baseSeq !== 'number' || !Number.isInteger(baseSeq) || baseSeq < -1) {
		errors.push(`Missing or invalid baseSeq: ${r.baseSeq}`);
	}
	const staleBaseSeq = typeof baseSeq === 'number' && Number.isInteger(baseSeq) && baseSeq >= 0 && baseSeq !== projection.lastSeq;
	if (staleBaseSeq) {
		errors.push(`Stale baseSeq: response has ${baseSeq}, projection is at ${projection.lastSeq}`);
	}

	// 3. Validate nodeUpdates
	let hasDestructivePlan = false;
	let requiresConfirmation = false;

	if (Array.isArray(r.nodeUpdates)) {
		for (const update of r.nodeUpdates as NodeUpdate[]) {
			if (typeof update.nodeId !== 'number') {
				errors.push(`nodeUpdate has invalid nodeId: ${update.nodeId}`);
				continue;
			}
			if (!projection.byId.has(update.nodeId)) {
				errors.push(`nodeUpdate references unknown node #${update.nodeId}`);
			}
			if (update.nodeId === projection.rootId) {
				errors.push(`nodeUpdate references root node #${update.nodeId} - rejected`);
			}
			if (projection.deletedNodes.has(update.nodeId)) {
				errors.push(`nodeUpdate references hard-deleted node #${update.nodeId}`);
			}
		}
	}

	// 4. Validate operationPlan
	if (Array.isArray(r.operationPlan)) {
		for (const item of r.operationPlan as OperationPlanItem[]) {
			if (item.operation !== 'archive' && item.operation !== 'delete') {
				errors.push(`Unknown operation: ${item.operation}`);
				continue;
			}

			if (!Array.isArray(item.targetIds) || item.targetIds.length === 0) {
				errors.push('operationPlan item has no targetIds');
				continue;
			}

			hasDestructivePlan = true;

			for (const targetId of item.targetIds) {
				if (typeof targetId !== 'number') {
					errors.push(`Invalid targetId: ${targetId}`);
					continue;
				}
				if (!projection.byId.has(targetId)) {
					errors.push(`operationPlan targets unknown node #${targetId}`);
				}
				if (projection.deletedNodes.has(targetId)) {
					warnings.push(`operationPlan targets already-deleted node #${targetId}`);
				}
				if (targetId === projection.headId) {
					errors.push(`operationPlan targets current head node #${targetId} - rejected`);
				}
				if (targetId === projection.rootId) {
					errors.push(`operationPlan targets root node #${targetId} - rejected`);
				}
				if (projection.protectedNodes.has(targetId)) {
					warnings.push(`operationPlan targets protected node #${targetId} - requires confirmation`);
					requiresConfirmation = true;
				}
			}

			if (item.risk === 'high') {
				requiresConfirmation = true;
			}

			if (item.requiresConfirmation) {
				requiresConfirmation = true;
			}

			if (item.operation === 'delete') {
				requiresConfirmation = true;
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		staleBaseSeq,
		hasDestructivePlan,
		requiresConfirmation,
	};
}
