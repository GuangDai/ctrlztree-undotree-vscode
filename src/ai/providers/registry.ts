/**
 * Provider registry for the AI subsystem.
 *
 * WHAT IT DOES:
 *   Maps ProviderName to AiProvider instances. The extension registers
 *   all 4 providers at activation time; AiService resolves by name at runtime.
 *
 * KEY EXPORTS:
 *   ProviderRegistry — register/get/has/list
 *   ProviderCapabilities — static capability flags per provider
 *   AiProvider — the interface BaseAiProvider implements
 *   createDefaultCapabilities(name) → ProviderCapabilities
 */

import { UnifiedAiRequest, UnifiedAiResponse, AiProviderError } from '../types';

export interface ProviderCapabilities {
    supportsSystemMessage: boolean;
    maxContextTokens: number;
}

export interface AiProvider {
    readonly name: string;
    readonly capabilities: ProviderCapabilities;
    sendRequest(req: UnifiedAiRequest, apiKey: string, signal?: AbortSignal, baseUrl?: string): Promise<UnifiedAiResponse | AiProviderError>;
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
            return { supportsSystemMessage: true, maxContextTokens: 128000 };
        case 'openai-chat-compatible':
            return { supportsSystemMessage: true, maxContextTokens: 128000 };
        case 'anthropic-messages':
            return { supportsSystemMessage: true, maxContextTokens: 200000 };
        case 'custom-http-json':
            return { supportsSystemMessage: false, maxContextTokens: 32000 };
    }
}
