import { UnifiedAiRequest, UnifiedAiResponse, AiProviderError } from '../types';
import { ProviderRequest, ProviderResponse } from './openaiChatCompatibleProvider';

export function buildOpenAIResponsesRequest(
	req: UnifiedAiRequest,
	apiKey: string,
	baseUrl: string
): ProviderRequest {
	const input: Array<{ role: string; content: string }> = [];

	// OpenAI Responses API uses `instructions` for system prompt, `input` for conversation
	// The system prompt goes into `instructions`, user/assistant messages go into `input`
	for (const msg of req.messages) {
		input.push({ role: msg.role, content: msg.content });
	}

	const body: Record<string, unknown> = {
		model: req.model,
		input,
		max_output_tokens: req.maxOutputTokens,
		temperature: req.temperature,
		top_p: req.topP,
		store: false,
	};

	if (req.system) {
		body.instructions = req.system;
	}

	if (req.toolMode === 'force_schema_tool') {
		body.text = {
			format: {
				type: 'json_schema',
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

export function parseOpenAIResponsesResponse(
	status: number,
	body: string
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

	// Responses API returns output array with message items
	const output = parsed.output;
	if (!Array.isArray(output)) {
		return { ok: false, error: 'No output in response', statusCode: status, retryable: false };
	}

	// Find first text output
	const textOutput = output.find((o: any) => o.type === 'message' && o.content);
	if (!textOutput) {
		return { ok: false, error: 'No message content in response output', statusCode: status, retryable: false };
	}

	const content = Array.isArray(textOutput.content)
		? textOutput.content.map((c: any) => c.text || '').join('\n')
		: textOutput.content;

	if (!content) {
		return { ok: false, error: 'Empty response content', statusCode: status, retryable: false };
	}

	// Try to parse as structured JSON
	try {
		const structured = JSON.parse(content.trim());
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
		// Plain text
	}

	return {
		version: '1',
		task: 'summarize_node',
		baseSeq: 0,
		nodeUpdates: [{ nodeId: -1, summary: content.trim() }],
		operationPlan: [],
		warnings: [],
	};
}
