import { UnifiedAiRequest, UnifiedAiResponse, AiProviderError } from '../types';
import { ProviderRequest, ProviderResponse } from './openaiChatCompatibleProvider';

export function buildAnthropicMessagesRequest(
	req: UnifiedAiRequest,
	apiKey: string,
	baseUrl: string
): ProviderRequest {
	const messages: Array<{ role: string; content: string }> = [];

	for (const msg of req.messages) {
		messages.push({ role: msg.role, content: msg.content });
	}

	const body: Record<string, unknown> = {
		model: req.model,
		messages,
		max_tokens: req.maxOutputTokens,
		temperature: req.temperature,
		top_p: req.topP,
	};

	if (req.system) {
		body.system = req.system;
	}

	if (req.toolMode === 'force_schema_tool' && req.responseSchema) {
		body.tools = [{
			name: 'structured_output',
			description: 'Return the response in the specified JSON format',
			input_schema: req.responseSchema,
		}];
		body.tool_choice = { type: 'tool', name: 'structured_output' };
	}

	return {
		url: `${baseUrl}`,
		method: 'POST',
		headers: {
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	};
}

export function parseAnthropicMessagesResponse(
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

	// Check for tool_use response (structured output)
	const toolUse = parsed.content?.find?.((c: any) => c.type === 'tool_use');
	if (toolUse?.input) {
		try {
			const input = typeof toolUse.input === 'string' ? JSON.parse(toolUse.input) : toolUse.input;
			return {
				version: '1',
				task: input.task || 'summarize_node',
				baseSeq: input.baseSeq ?? 0,
				nodeUpdates: Array.isArray(input.nodeUpdates) ? input.nodeUpdates : [],
				operationPlan: Array.isArray(input.operationPlan) ? input.operationPlan : [],
				warnings: Array.isArray(input.warnings) ? input.warnings : [],
			};
		} catch {
			// Fall through
		}
	}

	// Check for text content
	const textContent = parsed.content?.find?.((c: any) => c.type === 'text');
	if (textContent?.text) {
		// Try parsing text as JSON
		try {
			const structured = JSON.parse(textContent.text);
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
			// Plain text summary
		}

		if (strictSchema) {
			return { ok: false, error: 'Expected structured JSON response but received plain text', statusCode: status, retryable: false };
		}

		return {
			version: '1',
			task: 'summarize_node',
			baseSeq: 0,
			nodeUpdates: [{ nodeId: 0, summary: textContent.text }],
			operationPlan: [],
			warnings: [],
		};
	}

	return { ok: false, error: 'No content in response', statusCode: status, retryable: false };
}
