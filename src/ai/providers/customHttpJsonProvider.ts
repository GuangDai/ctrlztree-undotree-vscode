import { UnifiedAiRequest, UnifiedAiResponse, AiProviderError } from '../types';
import { ProviderRequest, ProviderResponse } from './openaiChatCompatibleProvider';

export function buildCustomHttpJsonRequest(
	req: UnifiedAiRequest,
	apiKey: string,
	baseUrl: string
): ProviderRequest {
	const body: Record<string, unknown> = {
		model: req.model,
		messages: req.messages.map(m => ({ role: m.role, content: m.content })),
		max_tokens: req.maxOutputTokens,
		temperature: req.temperature,
		top_p: req.topP,
		stream: false,
	};

	if (req.system) {
		body.system = req.system;
	}

	if (req.responseSchema) {
		body.response_format = {
			type: 'json_object',
			schema: req.responseSchema
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

export function parseCustomHttpJsonResponse(
	status: number,
	body: string,
	strictSchema?: boolean
): ProviderResponse {
	if (status < 200 || status >= 300) {
		let errorMsg = `HTTP ${status}`;
		try {
			const parsed = JSON.parse(body);
			if (parsed.error) {
				errorMsg = typeof parsed.error === 'string' ? parsed.error : parsed.error.message || errorMsg;
			}
		} catch {
			// Use default
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

	// Try to extract structured AI response from various common formats
	const content = parsed.choices?.[0]?.message?.content
		|| parsed.response
		|| parsed.content
		|| parsed.text
		|| parsed;

	if (typeof content === 'string') {
		try {
			const structured = JSON.parse(content);
			return normalizeResponse(structured);
		} catch {
			if (strictSchema) {
				return { ok: false, error: 'Expected structured JSON response but received plain text', statusCode: status, retryable: false };
			}
			return {
				version: '1', task: 'summarize_node', baseSeq: 0,
				nodeUpdates: [{ nodeId: 0, summary: content }],
				operationPlan: [], warnings: [],
			};
		}
	}

	if (typeof content === 'object' && content !== null) {
		return normalizeResponse(content);
	}

	return { ok: false, error: 'Unrecognized response format', statusCode: status, retryable: false };
}

function normalizeResponse(obj: Record<string, unknown>): UnifiedAiResponse {
	return {
		version: '1',
		task: (obj.task as any) || 'summarize_node',
		baseSeq: (obj.baseSeq as number) ?? 0,
		nodeUpdates: Array.isArray(obj.nodeUpdates) ? obj.nodeUpdates as any[] : [],
		operationPlan: Array.isArray(obj.operationPlan) ? obj.operationPlan as any[] : [],
		warnings: Array.isArray(obj.warnings) ? obj.warnings as string[] : [],
	};
}
