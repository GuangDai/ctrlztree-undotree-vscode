/**
 * Provider for the Anthropic Messages API.
 *
 * Implements ProviderHooks:
 *   - Auth via x-api-key header + anthropic-version
 *   - Messages array + optional system field
 *   - Content extracted from content[0].text or tool_use.input
 */

import { UnifiedAiRequest } from '../types';
import { ProviderHooks } from './providerInterfaces';

export const anthropicMessagesHooks: ProviderHooks = {
    buildHeaders(apiKey: string): Record<string, string> {
        return {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        };
    },

    buildPath(): string {
        return '/v1/messages';
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
        const content = responseJson.content as any[] | undefined;
        if (!Array.isArray(content)) { return null; }

        const textBlock = content.find((c: any) => c.type === 'text');
        if (textBlock && typeof textBlock.text === 'string') {
            return textBlock.text;
        }

        const toolBlock = content.find((c: any) => c.type === 'tool_use');
        if (toolBlock?.input) {
            return typeof toolBlock.input === 'string'
                ? toolBlock.input
                : JSON.stringify(toolBlock.input);
        }

        return null;
    },
};
