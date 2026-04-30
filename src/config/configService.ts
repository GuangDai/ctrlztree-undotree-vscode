import { CONFIG_DEFAULTS } from './defaults';

export interface CtrlZTreeUserConfig {
	enablePruning: boolean;
	maxHistoryNodesPerDocument: number;
	maxTrackedDocuments: number;
}

export interface AiUserConfig {
	enabled: boolean;
	provider: string;
	model: string;
	baseUrl: string;
}

export interface ClampedAiConfig {
	enabled: boolean;
	provider: string;
	model: string;
	baseUrl: string;
	valid: boolean;
	errors: string[];
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

export function clampAiConfig(raw: Partial<AiUserConfig>): ClampedAiConfig {
	const errors: string[] = [];

	const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : CONFIG_DEFAULTS.ai.defaultEnabled;

	const validProviders = CONFIG_DEFAULTS.ai.validProviders as readonly string[];
	const provider = typeof raw.provider === 'string' ? raw.provider : CONFIG_DEFAULTS.ai.defaultProvider;
	if (!validProviders.includes(provider)) {
		errors.push(`Invalid AI provider "${provider}". Must be one of: ${validProviders.join(', ')}`);
	}

	const model = typeof raw.model === 'string' ? raw.model.trim() : '';
	if (enabled && model === '') {
		errors.push('AI model is required when AI is enabled');
	}

	const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
	if (enabled && baseUrl !== '' && !isValidUrl(baseUrl)) {
		errors.push(`Invalid AI baseUrl format: "${baseUrl}"`);
	}

	return {
		enabled,
		provider: validProviders.includes(provider) ? provider : CONFIG_DEFAULTS.ai.defaultProvider,
		model,
		baseUrl,
		valid: errors.length === 0,
		errors,
	};
}

function isValidUrl(str: string): boolean {
	try {
		const url = new URL(str);
		if (url.protocol === 'https:') {
			return true;
		}
		// Only allow http:// for localhost/127.0.0.1
		if (url.protocol === 'http:') {
			const hostname = url.hostname.toLowerCase();
			return hostname === 'localhost' || hostname === '127.0.0.1';
		}
		return false;
	} catch {
		return false;
	}
}
