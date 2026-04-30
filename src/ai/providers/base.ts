import { UnifiedAiRequest, UnifiedAiResponse, AiProviderError } from '../types';
import { AiProvider, ProviderCapabilities, ProviderName } from './registry';
import { ProviderRequest, ProviderResponse } from './openaiChatCompatibleProvider';

export class BaseAiProvider implements AiProvider {
	constructor(
		public readonly name: ProviderName,
		public readonly capabilities: ProviderCapabilities,
		private baseUrl: string,
		private buildRequest: (req: UnifiedAiRequest, apiKey: string, baseUrl: string) => ProviderRequest,
		private parseResponse: (status: number, body: string, strictSchema?: boolean) => ProviderResponse,
		private fetchFn: (url: string, init?: any) => Promise<any> = (globalThis as any).fetch?.bind(globalThis),
	) {}

	async sendRequest(
		req: UnifiedAiRequest,
		apiKey: string,
		signal?: AbortSignal
	): Promise<UnifiedAiResponse | AiProviderError> {
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
			if (err?.name === 'AbortError') {
				return { ok: false, error: 'Request aborted', statusCode: undefined, retryable: true };
			}
			return { ok: false, error: `Network error: ${err?.message || 'Unknown'}`, statusCode: undefined, retryable: true };
		}
	}
}
