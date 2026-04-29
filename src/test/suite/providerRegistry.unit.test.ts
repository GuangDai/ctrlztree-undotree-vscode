import * as assert from 'assert';
import { ProviderRegistry, createDefaultCapabilities, AiProvider, ProviderName } from '../../ai/providers/registry';
import { UnifiedAiRequest, UnifiedAiResponse } from '../../ai/types';

suite('ProviderRegistry', () => {
	let registry: ProviderRegistry;

	setup(() => {
		registry = new ProviderRegistry();
	});

	function makeProvider(name: string): AiProvider {
		return {
			name,
			capabilities: createDefaultCapabilities(name as ProviderName),
			sendRequest: async () => ({
				version: '1', task: 'summarize_node', baseSeq: 0,
				nodeUpdates: [], operationPlan: [], warnings: []
			})
		};
	}

	test('register adds a provider', () => {
		registry.register('openai-responses', makeProvider('openai-responses'));
		assert.strictEqual(registry.has('openai-responses'), true);
	});

	test('get returns the registered provider', () => {
		const provider = makeProvider('openai-responses');
		registry.register('openai-responses', provider);
		assert.strictEqual(registry.get('openai-responses'), provider);
	});

	test('get returns undefined for unregistered provider', () => {
		assert.strictEqual(registry.get('openai-responses'), undefined);
	});

	test('register throws on duplicate', () => {
		registry.register('openai-responses', makeProvider('openai-responses'));
		assert.throws(() => {
			registry.register('openai-responses', makeProvider('openai-responses'));
		}, /already registered/);
	});

	test('has returns false for unregistered provider', () => {
		assert.strictEqual(registry.has('openai-responses'), false);
	});

	test('list returns empty initially', () => {
		assert.deepStrictEqual(registry.list(), []);
	});

	test('list returns registered provider names', () => {
		registry.register('openai-responses', makeProvider('openai-responses'));
		registry.register('anthropic-messages', makeProvider('anthropic-messages'));
		const names = registry.list();
		assert.strictEqual(names.length, 2);
		assert.ok(names.includes('openai-responses'));
		assert.ok(names.includes('anthropic-messages'));
	});

	test('createDefaultCapabilities returns correct capabilities', () => {
		const caps = createDefaultCapabilities('openai-responses');
		assert.strictEqual(caps.supportsSystemMessage, true);
		assert.strictEqual(caps.supportsJsonSchema, true);
		assert.strictEqual(caps.supportsTools, true);
	});

	test('anthropic capabilities correctly set', () => {
		const caps = createDefaultCapabilities('anthropic-messages');
		assert.strictEqual(caps.supportsSystemMessage, true);
		assert.strictEqual(caps.supportsJsonSchema, false);
		assert.strictEqual(caps.supportsParallelToolCalls, false);
	});

	test('custom-http-json has minimal capabilities', () => {
		const caps = createDefaultCapabilities('custom-http-json');
		assert.strictEqual(caps.supportsTools, false);
	});

	test('all four provider names are supported', () => {
		const names: ProviderName[] = ['openai-responses', 'openai-chat-compatible', 'anthropic-messages', 'custom-http-json'];
		for (const name of names) {
			assert.doesNotThrow(() => createDefaultCapabilities(name));
		}
	});
});
