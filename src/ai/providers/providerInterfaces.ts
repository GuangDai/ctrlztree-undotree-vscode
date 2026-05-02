/**
 * Provider hook interfaces for the AI provider layer.
 *
 * WHAT IT DOES:
 *   Defines the 3 hooks each provider must implement. The base provider
 *   (base.ts) owns all HTTP construction and response parsing; providers
 *   only supply these small, focused hooks.
 *
 * HARD RULES (enforced by the base provider, not by the interface):
 *   - NEVER include max_tokens / max_completion_tokens in buildBody
 *   - NEVER include response_format / json_schema in buildBody
 *   - temperature and top_p are OPTIONAL — only include if explicitly set
 *
 * KEY EXPORTS:
 *   ProviderHooks — { buildHeaders, buildBody, extractContent }
 */

import { UnifiedAiRequest } from '../types';

export interface ProviderHooks {
    /** Return provider-specific HTTP headers (auth + content-type). */
    buildHeaders(apiKey: string): Record<string, string>;

    /**
     * Build the HTTP request body as a plain object (base provider handles JSON.stringify).
     * PATH is appended to the baseUrl (e.g. "/v1/chat/completions").
     */
    buildPath(): string;
    buildBody(req: UnifiedAiRequest): Record<string, unknown>;

    /**
     * Extract the text content string from the API's parsed JSON response body.
     * Return null if no content is found.
     */
    extractContent(responseJson: Record<string, unknown>): string | null;
}
