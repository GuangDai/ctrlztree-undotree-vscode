import { UnifiedAiRequest, UnifiedAiResponse, AiProviderError } from '../types';

export interface ProviderCapabilities {
	supportsSystemMessage: boolean;
	supportsJsonSchema: boolean;
	supportsTools: boolean;
	supportsParallelToolCalls: boolean;
	maxContextTokens: number;
}

export interface AiProvider {
	readonly name: string;
	readonly capabilities: ProviderCapabilities;
	sendRequest(req: UnifiedAiRequest, apiKey: string): Promise<UnifiedAiResponse | AiProviderError>;
	validateEndpoint?(baseUrl: string): { valid: boolean; reason?: string };
}

export type ProviderName = 'openai-responses' | 'openai-chat-compatible' | 'anthropic-messages' | 'custom-http-json';

export class ProviderRegistry {
	private providers = new Map<ProviderName, AiProvider>();

	register(name: ProviderName, provider: AiProvider): void {
		if (this.providers.has(name)) {
			throw new Error(`Provider '${name}' is already registered`);
		}
		this.providers.set(name, provider);
	}

	get(name: ProviderName): AiProvider | undefined {
		return this.providers.get(name);
	}

	has(name: ProviderName): boolean {
		return this.providers.has(name);
	}

	list(): ProviderName[] {
		return Array.from(this.providers.keys());
	}
}

export function createDefaultCapabilities(provider: ProviderName): ProviderCapabilities {
	switch (provider) {
		case 'openai-responses':
			return {
				supportsSystemMessage: true,
				supportsJsonSchema: true,
				supportsTools: true,
				supportsParallelToolCalls: true,
				maxContextTokens: 128000
			};
		case 'openai-chat-compatible':
			return {
				supportsSystemMessage: true,
				supportsJsonSchema: true,
				supportsTools: true,
				supportsParallelToolCalls: true,
				maxContextTokens: 128000
			};
		case 'anthropic-messages':
			return {
				supportsSystemMessage: true,
				supportsJsonSchema: false,
				supportsTools: true,
				supportsParallelToolCalls: false,
				maxContextTokens: 200000
			};
		case 'custom-http-json':
			return {
				supportsSystemMessage: false,
				supportsJsonSchema: false,
				supportsTools: false,
				supportsParallelToolCalls: false,
				maxContextTokens: 32000
			};
	}
}
