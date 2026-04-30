import { UnifiedAiRequest, UnifiedAiResponse, AiProviderError } from '../types';
import { AiProvider, ProviderCapabilities, ProviderName } from './registry';
import { ProviderRequest, ProviderResponse } from './openaiChatCompatibleProvider';

function getFetch(): (url: string, init?: any) => Promise<any> {
	if (typeof (globalThis as any).fetch === 'function') {
		return (globalThis as any).fetch.bind(globalThis);
	}
	if (typeof (globalThis as any).globalThis?.fetch === 'function') {
		return (globalThis as any).globalThis.fetch.bind(globalThis);
	}
	// Node 18+ built-in fetch may be available under different paths
	try {
		const nodeFetch = require('node:http') as any;
		if (nodeFetch) { /* exists, but not fetch */ }
	} catch { /* ignore */ }
	return null as any;
}

export class BaseAiProvider implements AiProvider {
	private fetchFn: ((url: string, init?: any) => Promise<any>) | null;

	constructor(
		public readonly name: ProviderName,
		public readonly capabilities: ProviderCapabilities,
		private baseUrl: string,
		private buildRequest: (req: UnifiedAiRequest, apiKey: string, baseUrl: string) => ProviderRequest,
		private parseResponse: (status: number, body: string, strictSchema?: boolean) => ProviderResponse,
		fetchFn?: (url: string, init?: any) => Promise<any>,
	) {
		this.fetchFn = fetchFn ?? getFetch();
	}

	async sendRequest(
		req: UnifiedAiRequest,
		apiKey: string,
		signal?: AbortSignal
	): Promise<UnifiedAiResponse | AiProviderError> {
		if (!this.fetchFn) {
			return { ok: false, error: 'global fetch is not available in this VS Code version (requires Node 18+)', statusCode: undefined, retryable: false };
		}

		const httpReq = this.buildRequest(req, apiKey, this.baseUrl);
		try {
			const response = await this.fetchFn(httpReq.url, {
				method: httpReq.method,
				headers: httpReq.headers,
				body: httpReq.body,
				signal,
			});
			const body = await response.text();
			const strictSchema = req.toolMode === 'force_schema_tool';
			return this.parseResponse(response.status, body, strictSchema);
		} catch (err: any) {
			if (err?.name === 'AbortError' || err?.message?.includes('aborted')) {
				return { ok: false, error: 'Request aborted', statusCode: undefined, retryable: true };
			}
			return { ok: false, error: `Network error: ${err?.message || 'Unknown'}`, statusCode: undefined, retryable: true };
		}
	}
}
