export const CONFIG_DEFAULTS = {
	enablePruning: true,
	maxHistoryNodesPerDocument: 1000,
	maxTrackedDocuments: 100,
	maxHistoryNodesPerDocumentMin: 50,
	maxHistoryNodesPerDocumentMax: 100000,
	maxTrackedDocumentsMin: 1,
	maxTrackedDocumentsMax: 10000,
	ai: {
		validProviders: ['openai-chat-compatible', 'openai-responses', 'anthropic-messages', 'custom-http-json'] as const,
		defaultProvider: 'openai-chat-compatible' as const,
		defaultEnabled: false,
		defaultModel: '',
		defaultBaseUrl: '',
		defaultTimeoutMs: 30000,
		defaultMaxRetries: 2,
		defaultMaxOutputTokens: 512,
		defaultTemperature: 0.2,
		defaultTopP: 1,
		autoRename: {
			defaultEnabled: false,
			defaultDebounceMs: 2000,
			defaultMinDiffBytes: 20,
			defaultMaxDiffBytes: 8000,
		},
	}
};
