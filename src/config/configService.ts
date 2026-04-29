import { CONFIG_DEFAULTS } from './defaults';

export interface CtrlZTreeUserConfig {
	enablePruning: boolean;
	maxHistoryNodesPerDocument: number;
	maxTrackedDocuments: number;
}

export function clampConfig(
	raw: Partial<CtrlZTreeUserConfig>,
	onWarn?: (message: string) => void
): CtrlZTreeUserConfig {
	let enablePruning = CONFIG_DEFAULTS.enablePruning;
	if (typeof raw.enablePruning === 'boolean') {
		enablePruning = raw.enablePruning;
	} else if (raw.enablePruning !== undefined) {
		onWarn?.(`CtrlZTree Config: enablePruning is not boolean, using default ${CONFIG_DEFAULTS.enablePruning}`);
	}

	let maxHistoryNodesPerDocument = CONFIG_DEFAULTS.maxHistoryNodesPerDocument;
	if (typeof raw.maxHistoryNodesPerDocument === 'number') {
		const val = raw.maxHistoryNodesPerDocument;
		if (!Number.isFinite(val) || Number.isNaN(val)) {
			onWarn?.(`CtrlZTree Config: maxHistoryNodesPerDocument is NaN/infinite, using default ${CONFIG_DEFAULTS.maxHistoryNodesPerDocument}`);
		} else {
			maxHistoryNodesPerDocument = Math.max(
				CONFIG_DEFAULTS.maxHistoryNodesPerDocumentMin,
				Math.min(CONFIG_DEFAULTS.maxHistoryNodesPerDocumentMax, Math.floor(val))
			);
			if (maxHistoryNodesPerDocument !== val) {
				onWarn?.(`CtrlZTree Config: maxHistoryNodesPerDocument clamped from ${val} to ${maxHistoryNodesPerDocument}`);
			}
		}
	} else if (raw.maxHistoryNodesPerDocument !== undefined) {
		onWarn?.(`CtrlZTree Config: maxHistoryNodesPerDocument is not a number, using default ${CONFIG_DEFAULTS.maxHistoryNodesPerDocument}`);
	}

	let maxTrackedDocuments = CONFIG_DEFAULTS.maxTrackedDocuments;
	if (typeof raw.maxTrackedDocuments === 'number') {
		const val = raw.maxTrackedDocuments;
		if (!Number.isFinite(val) || Number.isNaN(val)) {
			onWarn?.(`CtrlZTree Config: maxTrackedDocuments is NaN/infinite, using default ${CONFIG_DEFAULTS.maxTrackedDocuments}`);
		} else {
			maxTrackedDocuments = Math.max(
				CONFIG_DEFAULTS.maxTrackedDocumentsMin,
				Math.min(CONFIG_DEFAULTS.maxTrackedDocumentsMax, Math.floor(val))
			);
			if (maxTrackedDocuments !== val) {
				onWarn?.(`CtrlZTree Config: maxTrackedDocuments clamped from ${val} to ${maxTrackedDocuments}`);
			}
		}
	} else if (raw.maxTrackedDocuments !== undefined) {
		onWarn?.(`CtrlZTree Config: maxTrackedDocuments is not a number, using default ${CONFIG_DEFAULTS.maxTrackedDocuments}`);
	}

	return { enablePruning, maxHistoryNodesPerDocument, maxTrackedDocuments };
}
