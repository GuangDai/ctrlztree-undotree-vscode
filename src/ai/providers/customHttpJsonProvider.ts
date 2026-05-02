/**
 * Provider for custom HTTP JSON endpoints.
 *
 * Implements ProviderHooks:
 *   - Auth via Bearer token (Authorization header)
 *   - Messages as standard chat-completions-shaped body
 *   - Content extracted from multiple common paths
 */

import { UnifiedAiRequest } from '../types';
import { ProviderHooks } from './providerInterfaces';

export const customHttpJsonHooks: ProviderHooks = {
    buildHeaders(apiKey: string): Record<string, string> {
        return {
            'Authorization': `Bearer ${apiKey}`,
        };
    },

    buildPath(): string {
        return '';
    },

    buildBody(req: UnifiedAiRequest): Record<string, unknown> {
        const body: Record<string, unknown> = {
            model: req.model,
            messages: req.messages.map(m => ({ role: m.role, content: m.content })),
        };

        if (req.system) { body.system = req.system; }
        if (req.temperature !== undefined) { body.temperature = req.temperature; }
        if (req.topP !== undefined) { body.top_p = req.topP; }

        return body;
    },

    extractContent(responseJson: Record<string, unknown>): string | null {
        // Try multiple common response shapes
        const content: unknown =
            (responseJson.choices as any[])?.[0]?.message?.content
            ?? responseJson.response
            ?? responseJson.content
            ?? responseJson.text;

        return typeof content === 'string' ? content : null;
    },
};
