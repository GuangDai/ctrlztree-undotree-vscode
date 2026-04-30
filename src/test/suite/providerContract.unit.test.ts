import * as assert from 'assert';
import { buildOpenAIChatCompatibleRequest, parseOpenAIChatCompatibleResponse } from '../../ai/providers/openaiChatCompatibleProvider';
import { buildAnthropicMessagesRequest, parseAnthropicMessagesResponse } from '../../ai/providers/anthropicMessagesProvider';
import { buildCustomHttpJsonRequest, parseCustomHttpJsonResponse } from '../../ai/providers/customHttpJsonProvider';
import { buildOpenAIResponsesRequest, parseOpenAIResponsesResponse } from '../../ai/providers/openaiResponsesProvider';
import { UnifiedAiRequest } from '../../ai/types';

function makeRequest(overrides: Partial<UnifiedAiRequest> = {}): UnifiedAiRequest {
	return {
		task: 'summarize_node',
		model: 'test-model',
		system: 'You summarize code diffs.',
		messages: [
			{ role: 'user', content: 'Diff: added function foo()' }
		],
		responseSchema: {
			type: 'object',
			properties: {
				task: { type: 'string' },
				nodeUpdates: { type: 'array' },
				operationPlan: { type: 'array' },
				warnings: { type: 'array' },
				baseSeq: { type: 'number' }
			}
		},
		maxOutputTokens: 512,
		temperature: 0.2,
		topP: 1,
		toolMode: 'none',
		parallelToolCalls: false,
		metadata: {
			promptVersion: 'v1',
			docFingerprint: 'fp-abc',
			headNodeId: 1,
			baseSeq: 10
		},
		...overrides,
	};
}

suite('OpenAI Chat-Compatible Provider', () => {
	test('buildRequest includes system message and user messages', () => {
		const req = makeRequest();
		const result = buildOpenAIChatCompatibleRequest(req, 'sk-test-key', 'https://api.openai.com/v1/chat/completions');

		assert.strictEqual(result.method, 'POST');
		assert.ok(result.headers['Authorization'].includes('sk-test-key'));
		assert.ok(result.headers['Authorization'].includes('Bearer'));

		const body = JSON.parse(result.body);
		assert.strictEqual(body.model, 'test-model');
		assert.strictEqual(body.messages.length, 2); // system + user
		assert.strictEqual(body.messages[0].role, 'system');
		assert.strictEqual(body.messages[1].role, 'user');
		assert.strictEqual(body.max_completion_tokens, 512);
	});

	test('buildRequest with toolMode adds response_format', () => {
		const req = makeRequest({ toolMode: 'force_schema_tool' });
		const result = buildOpenAIChatCompatibleRequest(req, 'key', 'https://api.example.com');
		const body = JSON.parse(result.body);
		assert.strictEqual(body.response_format.type, 'json_schema');
		assert.strictEqual(body.response_format.json_schema.strict, true);
	});

	test('buildRequest without system message omits system role', () => {
		const req = makeRequest({ system: '' });
		const result = buildOpenAIChatCompatibleRequest(req, 'key', 'https://api.example.com');
		const body = JSON.parse(result.body);
		assert.strictEqual(body.messages.length, 1);
	});

	test('parseResponse with valid structured output returns UnifiedAiResponse', () => {
		const responseBody = JSON.stringify({
			choices: [{
				message: {
					content: JSON.stringify({
						task: 'summarize_node',
						baseSeq: 10,
						nodeUpdates: [{ nodeId: 1, summary: 'Added foo()' }],
						operationPlan: [],
						warnings: []
					})
				}
			}]
		});

		const result = parseOpenAIChatCompatibleResponse(200, responseBody);
		assert.ok(!('ok' in result));
		assert.strictEqual((result as any).task, 'summarize_node');
	});

	test('parseResponse with HTTP error returns error result', () => {
		const result = parseOpenAIChatCompatibleResponse(429, '{"error":{"message":"Rate limited"}}');
		assert.strictEqual((result as any).ok, false);
		assert.strictEqual((result as any).statusCode, 429);
		assert.strictEqual((result as any).retryable, true);
	});

	test('parseResponse with 200 but invalid JSON returns error', () => {
		const result = parseOpenAIChatCompatibleResponse(200, 'not json');
		assert.strictEqual((result as any).ok, false);
	});
});

suite('Anthropic Messages Provider', () => {
	test('buildRequest uses x-api-key header and anthropic-version', () => {
		const req = makeRequest();
		const result = buildAnthropicMessagesRequest(req, 'sk-ant-key', 'https://api.anthropic.com/v1/messages');

		assert.strictEqual(result.headers['x-api-key'], 'sk-ant-key');
		assert.strictEqual(result.headers['anthropic-version'], '2023-06-01');

		const body = JSON.parse(result.body);
		assert.strictEqual(body.model, 'test-model');
		assert.strictEqual(body.max_tokens, 512);
		assert.strictEqual(body.system, 'You summarize code diffs.');
	});

	test('buildRequest with toolMode adds tool_use config', () => {
		const req = makeRequest({ toolMode: 'force_schema_tool' });
		const result = buildAnthropicMessagesRequest(req, 'key', 'https://api.example.com');
		const body = JSON.parse(result.body);
		assert.strictEqual(body.tools.length, 1);
		assert.strictEqual(body.tools[0].name, 'structured_output');
		assert.strictEqual(body.tool_choice.type, 'tool');
	});

	test('parseResponse with tool_use content returns structured output', () => {
		const responseBody = JSON.stringify({
			content: [{
				type: 'tool_use',
				name: 'structured_output',
				input: {
					task: 'propose_prune',
					baseSeq: 5,
					nodeUpdates: [],
					operationPlan: [],
					warnings: []
				}
			}]
		});
		const result = parseAnthropicMessagesResponse(200, responseBody);
		assert.ok(!('ok' in result));
		assert.strictEqual((result as any).task, 'propose_prune');
	});

	test('parseResponse with text content returns summary', () => {
		const responseBody = JSON.stringify({
			content: [{ type: 'text', text: 'Added function foo()' }]
		});
		const result = parseAnthropicMessagesResponse(200, responseBody);
		assert.ok(!('ok' in result));
		assert.strictEqual((result as any).nodeUpdates[0].summary, 'Added function foo()');
	});
});

suite('Custom HTTP JSON Provider', () => {
	test('buildRequest produces generic chat format', () => {
		const req = makeRequest();
		const result = buildCustomHttpJsonRequest(req, 'key', 'https://custom.api.com/chat');

		const body = JSON.parse(result.body);
		assert.strictEqual(body.model, 'test-model');
		assert.strictEqual(body.stream, false);
	});

	test('parseResponse handles choices[0].message.content format', () => {
		const responseBody = JSON.stringify({
			choices: [{ message: { content: 'Summary: function added' } }]
		});
		const result = parseCustomHttpJsonResponse(200, responseBody);
		assert.ok(!('ok' in result));
		assert.strictEqual((result as any).nodeUpdates[0].summary, 'Summary: function added');
	});

	test('parseResponse handles response.content format', () => {
		const responseBody = JSON.stringify({
			content: 'Direct content response'
		});
		const result = parseCustomHttpJsonResponse(200, responseBody);
		assert.ok(!('ok' in result));
	});

	test('parseResponse handles error status', () => {
		const result = parseCustomHttpJsonResponse(500, '{"error":"Internal"}');
		assert.strictEqual((result as any).ok, false);
		assert.strictEqual((result as any).retryable, true);
	});

	test('apiKey is present in Authorization header', () => {
		const req = makeRequest();
		const result = buildCustomHttpJsonRequest(req, 'my-secret-key', 'https://example.com');
		assert.ok(result.headers['Authorization'].includes('my-secret-key'));
		assert.ok(result.headers['Authorization'].includes('Bearer'));
	});
});

suite('OpenAI Responses Provider', () => {
	test('buildRequest uses instructions for system prompt', () => {
		const req = makeRequest();
		const result = buildOpenAIResponsesRequest(req, 'key', 'https://api.openai.com/v1/responses');

		assert.strictEqual(result.method, 'POST');
		assert.ok(result.headers['Authorization'].includes('Bearer'));

		const body = JSON.parse(result.body);
		assert.strictEqual(body.model, 'test-model');
		assert.strictEqual(body.instructions, 'You summarize code diffs.');
		assert.strictEqual(body.store, false);
		assert.strictEqual(body.max_output_tokens, 512);
		assert.ok(Array.isArray(body.input));
		assert.strictEqual(body.input.length, 1);
	});

	test('buildRequest with toolMode adds text.format', () => {
		const req = makeRequest({ toolMode: 'force_schema_tool' });
		const result = buildOpenAIResponsesRequest(req, 'key', 'https://api.example.com');
		const body = JSON.parse(result.body);

		assert.strictEqual(body.text.format.type, 'json_schema');
		assert.strictEqual(body.text.format.strict, true);
	});

	test('parseResponse with JSON output returns structured', () => {
		const responseBody = JSON.stringify({
			output: [{
				type: 'message',
				content: [{
					type: 'output_text',
					text: JSON.stringify({
						task: 'rename_node',
						baseSeq: 5,
						nodeUpdates: [{ nodeId: 1, name: 'Add auth' }],
						operationPlan: [],
						warnings: []
					})
				}]
			}]
		});

		const result = parseOpenAIResponsesResponse(200, responseBody);
		assert.ok(!('ok' in result));
		assert.strictEqual((result as any).task, 'rename_node');
		assert.strictEqual((result as any).nodeUpdates[0].name, 'Add auth');
	});

	test('parseResponse with plain text returns summary', () => {
		const responseBody = JSON.stringify({
			output: [{
				type: 'message',
				content: [{ type: 'output_text', text: 'Added authentication middleware.' }]
			}]
		});
		const result = parseOpenAIResponsesResponse(200, responseBody);
		assert.ok(!('ok' in result));
		assert.strictEqual((result as any).nodeUpdates[0].summary, 'Added authentication middleware.');
	});

	test('parseResponse with HTTP error returns error', () => {
		const result = parseOpenAIResponsesResponse(429, '{"error":{"message":"Rate limited"}}');
		assert.strictEqual((result as any).ok, false);
		assert.strictEqual((result as any).retryable, true);
	});
});
