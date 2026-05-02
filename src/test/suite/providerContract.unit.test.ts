import * as assert from 'assert';
import { openaiChatCompatibleHooks } from '../../ai/providers/openaiChatCompatibleProvider';
import { anthropicMessagesHooks } from '../../ai/providers/anthropicMessagesProvider';
import { customHttpJsonHooks } from '../../ai/providers/customHttpJsonProvider';
import { openaiResponsesHooks } from '../../ai/providers/openaiResponsesProvider';
import { UnifiedAiRequest } from '../../ai/types';

function makeRequest(overrides: Partial<UnifiedAiRequest> = {}): UnifiedAiRequest {
    return {
        task: 'summarize_node',
        model: 'test-model',
        system: 'You summarize code diffs.',
        messages: [
            { role: 'user', content: 'Diff: added function foo()' }
        ],
        temperature: 0.2,
        topP: 1,
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
    test('buildBody includes system message and user messages', () => {
        const req = makeRequest();
        const body = openaiChatCompatibleHooks.buildBody(req);

        assert.strictEqual(body.model, 'test-model');
        assert.ok(Array.isArray(body.messages));
        const msgs = body.messages as any[];
        assert.strictEqual(msgs.length, 2);
        assert.strictEqual(msgs[0].role, 'system');
        assert.strictEqual(msgs[1].role, 'user');
        // No max_tokens / max_completion_tokens
        assert.strictEqual((body as any).max_completion_tokens, undefined);
        assert.strictEqual((body as any).max_tokens, undefined);
    });

    test('buildBody omits temperature when not set', () => {
        const req = makeRequest({ temperature: undefined });
        const body = openaiChatCompatibleHooks.buildBody(req);
        assert.strictEqual((body as any).temperature, undefined);
    });

    test('buildBody includes temperature when set', () => {
        const req = makeRequest({ temperature: 0.3 });
        const body = openaiChatCompatibleHooks.buildBody(req);
        assert.strictEqual(body.temperature, 0.3);
    });

    test('buildHeaders includes Bearer auth', () => {
        const headers = openaiChatCompatibleHooks.buildHeaders('sk-test-key');
        assert.ok(headers['Authorization'].includes('Bearer'));
        assert.ok(headers['Authorization'].includes('sk-test-key'));
    });

    test('extractContent gets content from choices[0].message.content', () => {
        const content = openaiChatCompatibleHooks.extractContent({
            choices: [{ message: { content: 'hello world' } }]
        });
        assert.strictEqual(content, 'hello world');
    });

    test('extractContent returns null for missing content', () => {
        const content = openaiChatCompatibleHooks.extractContent({ choices: [] });
        assert.strictEqual(content, null);
    });
});

suite('Anthropic Messages Provider', () => {
    test('buildBody omits max_tokens', () => {
        const req = makeRequest();
        const body = anthropicMessagesHooks.buildBody(req);
        assert.strictEqual((body as any).max_tokens, undefined);
    });

    test('buildHeaders includes x-api-key and anthropic-version', () => {
        const headers = anthropicMessagesHooks.buildHeaders('my-key');
        assert.strictEqual(headers['x-api-key'], 'my-key');
        assert.strictEqual(headers['anthropic-version'], '2023-06-01');
    });

    test('extractContent gets text from content block', () => {
        const content = anthropicMessagesHooks.extractContent({
            content: [{ type: 'text', text: 'hello from claude' }]
        });
        assert.strictEqual(content, 'hello from claude');
    });

    test('extractContent falls back to tool_use input', () => {
        const content = anthropicMessagesHooks.extractContent({
            content: [{ type: 'tool_use', input: '{"task":"rename_node"}' }]
        });
        assert.ok(content?.includes('rename_node'));
    });
});

suite('OpenAI Responses Provider', () => {
    test('buildBody uses input array and instructions', () => {
        const req = makeRequest({ system: 'Be helpful.' });
        const body = openaiResponsesHooks.buildBody(req);
        assert.strictEqual(body.model, 'test-model');
        assert.strictEqual(body.instructions, 'Be helpful.');
        assert.ok(Array.isArray(body.input));
    });

    test('extractContent from output array', () => {
        const content = openaiResponsesHooks.extractContent({
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'summary here' }] }]
        });
        assert.strictEqual(content, 'summary here');
    });
});

suite('Custom HTTP JSON Provider', () => {
    test('buildBody uses messages array', () => {
        const req = makeRequest();
        const body = customHttpJsonHooks.buildBody(req);
        assert.strictEqual(body.model, 'test-model');
        assert.ok(Array.isArray(body.messages));
    });

    test('extractContent tries multiple paths', () => {
        const content = customHttpJsonHooks.extractContent({ text: 'direct text' });
        assert.strictEqual(content, 'direct text');
    });
});
