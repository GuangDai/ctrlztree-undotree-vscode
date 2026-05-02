/**
 * Base AI provider — owns the full HTTP request/response pipeline.
 *
 * WHAT IT DOES:
 *   Takes a ProviderHooks delegate for provider-specific headers/body/content-extraction,
 *   and handles everything else: URL construction, JSON serialization, fetch,
 *   HTTP error handling, and robust JSON parsing via responseParser.
 *
 * ARCHITECTURAL ROLE:
 *   The single HTTP pipeline for all 4 providers. Eliminates ~300 lines of
 *   duplicated request-building and response-parsing code.
 *
 * HARD RULES (built into this pipeline):
 *   - NEVER sends max_tokens / max_completion_tokens in the HTTP body.
 *   - NEVER sends response_format / json_schema in the HTTP body.
 *   - temperature and top_p are only included if explicitly set in the request.
 */

import { UnifiedAiRequest, UnifiedAiResponse, AiProviderError } from '../types';
import { AiProvider, ProviderCapabilities, ProviderName } from './registry';
import { ProviderHooks } from './providerInterfaces';
import { parseRobustJson } from '../responseParser';

function getFetch(): ((url: string, init?: any) => Promise<any>) | null {
    if (typeof (globalThis as any).fetch === 'function') {
        return (globalThis as any).fetch.bind(globalThis);
    }
    return null;
}

export class BaseAiProvider implements AiProvider {
    private fetchFn: ((url: string, init?: any) => Promise<any>) | null;

    constructor(
        public readonly name: ProviderName,
        public readonly capabilities: ProviderCapabilities,
        private defaultBaseUrl: string,
        private hooks: ProviderHooks,
        fetchFn?: (url: string, init?: any) => Promise<any>,
    ) {
        this.fetchFn = fetchFn ?? getFetch();
    }

    private resolveUrl(baseUrlOverride?: string): string {
        const base = baseUrlOverride || this.defaultBaseUrl;
        const path = this.hooks.buildPath();
        return `${base.replace(/\/+$/, '')}${path}`;
    }

    async sendRequest(
        req: UnifiedAiRequest,
        apiKey: string,
        signal?: AbortSignal,
        baseUrlOverride?: string,
    ): Promise<UnifiedAiResponse | AiProviderError> {
        if (!this.fetchFn) {
            return { ok: false, error: 'fetch is not available', retryable: false };
        }

        const url = this.resolveUrl(baseUrlOverride);
        if (!url || url === '/') {
            return { ok: false, error: 'AI base URL is not configured', retryable: false };
        }

        const body = this.hooks.buildBody(req);
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...this.hooks.buildHeaders(apiKey),
        };

        try {
            const response = await this.fetchFn(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal,
            });

            const responseText = await response.text();
            return this.parseResponse(response.status, responseText, this.hooks);
        } catch (err: any) {
            if (err?.name === 'AbortError' || signal?.aborted) {
                const reason = signal && 'reason' in signal ? (signal as any).reason : undefined
                return { ok: false, error: 'Request aborted', retryable: reason === 'Request timeout' }
            }
            return { ok: false, error: `Network error: ${err?.message || 'Unknown'}`, retryable: true };
        }
    }

    private parseResponse(
        status: number,
        body: string,
        hooks: ProviderHooks,
    ): UnifiedAiResponse | AiProviderError {
        if (status !== 200) {
            let errorMsg = `HTTP ${status}`;
            try {
                const parsed = JSON.parse(body);
                if (parsed.error?.message) {
                    errorMsg = parsed.error.message;
                } else if (typeof parsed.error === 'string') {
                    errorMsg = parsed.error;
                }
            } catch { /* use default */ }
            return {
                ok: false,
                error: errorMsg,
                statusCode: status,
                retryable: status === 429 || status >= 500,
            };
        }

        let responseJson: Record<string, unknown>;
        try {
            responseJson = JSON.parse(body);
        } catch {
            return { ok: false, error: 'Invalid JSON response from API', retryable: false };
        }

        const content = hooks.extractContent(responseJson);
        if (!content || content.trim().length === 0) {
            return { ok: false, error: 'Empty response from model (may be a reasoning model that consumed all tokens — try removing max_tokens from your endpoint config)', retryable: false };
        }

        const result = parseRobustJson(content);
        if (result.ok) {
            return result.response;
        }

        return {
            version: '1',
            task: 'summarize_node',
            baseSeq: -1,
            nodeUpdates: [{ nodeId: 0, summary: content.trim().substring(0, 200) }],
            operationPlan: [],
            warnings: [`parse_fallback: ${result.error}`],
        };
    }
}
