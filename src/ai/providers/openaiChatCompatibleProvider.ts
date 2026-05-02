/**
 * Provider for OpenAI Chat Completions API and compatible endpoints
 * (OpenRouter, vLLM, Ollama, LiteLLM, DeepSeek via liaobots, etc.).
 *
 * Implements ProviderHooks:
 *   - Auth via Bearer token
 *   - Messages array with optional system message as first entry
 *   - Content extracted from choices[0].message.content
 */

import { UnifiedAiRequest } from '../types';
import { ProviderHooks } from './providerInterfaces';

export const openaiChatCompatibleHooks: ProviderHooks = {
    buildHeaders(apiKey: string): Record<string, string> {
        return {
            'Authorization': `Bearer ${apiKey}`,
        };
    },

    buildPath(): string {
        return '';
    },

    buildBody(req: UnifiedAiRequest): Record<string, unknown> {
        const messages: Array<{ role: string; content: string }> = [];

        if (req.system) {
            messages.push({ role: 'system', content: req.system });
        }
        for (const msg of req.messages) {
            messages.push({ role: msg.role, content: msg.content });
        }

        const body: Record<string, unknown> = {
            model: req.model,
            messages,
        };

        if (req.temperature !== undefined) { body.temperature = req.temperature; }
        if (req.topP !== undefined) { body.top_p = req.topP; }

        return body;
    },

    extractContent(responseJson: Record<string, unknown>): string | null {
        const choices = responseJson.choices as any[] | undefined;
        const content = choices?.[0]?.message?.content;
        return typeof content === 'string' ? content : null;
    },
};
