import { UnifiedAiRequest, UnifiedAiResponse, AiProviderError } from '../types';

export interface ProviderRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

export type ProviderResponse = UnifiedAiResponse | AiProviderError;

export function buildOpenAIChatCompatibleRequest(
	req: UnifiedAiRequest,
	apiKey: string,
	baseUrl: string
): ProviderRequest {
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
		max_completion_tokens: req.maxOutputTokens,
		temperature: req.temperature,
		top_p: req.topP,
	};

	if (req.toolMode === 'force_schema_tool') {
		body.response_format = {
			type: 'json_schema',
			json_schema: {
				name: 'response',
				schema: req.responseSchema,
				strict: true
			}
		};
	}

	return {
		url: `${baseUrl}`,
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	};
}

export function parseOpenAIChatCompatibleResponse(
	status: number,
	body: string,
	strictSchema?: boolean
): ProviderResponse {
	if (status !== 200) {
		let errorMsg = `HTTP ${status}`;
		try {
			const parsed = JSON.parse(body);
			if (parsed.error?.message) {
				errorMsg = parsed.error.message;
			}
		} catch {
			// Use default error
		}
		return {
			ok: false,
			error: errorMsg,
			statusCode: status,
			retryable: status === 429 || status >= 500,
		};
	}

	let parsed: any;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { ok: false, error: 'Invalid JSON response', statusCode: status, retryable: false };
	}

	const content = parsed.choices?.[0]?.message?.content;
	if (!content) {
		return { ok: false, error: 'No content in response choices', statusCode: status, retryable: false };
	}

	// Try to parse the content as JSON (structured output)
	try {
		const structured = JSON.parse(content);
		if (structured && typeof structured === 'object') {
			return {
				version: '1',
				task: structured.task || 'summarize_node',
				baseSeq: structured.baseSeq ?? 0,
				nodeUpdates: Array.isArray(structured.nodeUpdates) ? structured.nodeUpdates : [],
				operationPlan: Array.isArray(structured.operationPlan) ? structured.operationPlan : [],
				warnings: Array.isArray(structured.warnings) ? structured.warnings : [],
			};
		}
	} catch {
		// Content is plain text, not structured JSON
	}

	if (strictSchema) {
		return { ok: false, error: 'Expected structured JSON response but received plain text', statusCode: status, retryable: false };
	}

	return {
		version: '1',
		task: 'summarize_node',
		baseSeq: 0,
		nodeUpdates: [{ nodeId: 0, summary: content }],
		operationPlan: [],
		warnings: [],
	};
}
