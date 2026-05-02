/**
 * Provider for the OpenAI Responses API.
 *
 * Implements ProviderHooks:
 *   - Auth via Bearer token
 *   - Messages as `input` array, system as `instructions`
 *   - Content extracted from output[].content text blocks
 */

import { UnifiedAiRequest } from '../types';
import { ProviderHooks } from './providerInterfaces';

export const openaiResponsesHooks: ProviderHooks = {
    buildHeaders(apiKey: string): Record<string, string> {
        return {
            'Authorization': `Bearer ${apiKey}`,
        };
    },

    buildPath(): string {
        return '/v1/responses';
    },

    buildBody(req: UnifiedAiRequest): Record<string, unknown> {
        const body: Record<string, unknown> = {
            model: req.model,
            input: req.messages.map(m => ({ role: m.role, content: m.content })),
        };

        if (req.system) { body.instructions = req.system; }
        if (req.temperature !== undefined) { body.temperature = req.temperature; }
        if (req.topP !== undefined) { body.top_p = req.topP; }

        return body;
    },

    extractContent(responseJson: Record<string, unknown>): string | null {
        const output = responseJson.output as any[] | undefined;
        if (!Array.isArray(output)) { return null; }

        for (const item of output) {
            if (item.type !== 'message') { continue; }
            const content = item.content;
            if (Array.isArray(content)) {
                return content.map((c: any) => typeof c.text === 'string' ? c.text : '').join('\n');
            }
            if (typeof content === 'string') { return content; }
        }

        return null;
    },
};
