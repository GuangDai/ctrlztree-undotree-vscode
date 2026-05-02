import * as assert from 'assert';
import { AiService } from '../../ai/aiService';
import { ProviderRegistry, createDefaultCapabilities, ProviderName } from '../../ai/providers/registry';
import { BaseAiProvider } from '../../ai/providers/base';
import { RequestScheduler } from '../../concurrency/requestScheduler';
import { createInMemorySecretStore } from '../../security/secretStore';
import { ClampedAiConfig } from '../../config/configService';
import { openaiChatCompatibleHooks } from '../../ai/providers/openaiChatCompatibleProvider';
import { anthropicMessagesHooks } from '../../ai/providers/anthropicMessagesProvider';
import { openaiResponsesHooks } from '../../ai/providers/openaiResponsesProvider';
import { customHttpJsonHooks } from '../../ai/providers/customHttpJsonProvider';

function makeAiService(overrides?: { fetchFn?: any }) {
    const registry = new ProviderRegistry();
    const scheduler = new RequestScheduler({ maxConcurrentRequests: 5, maxRequestsPerHour: 1000, timeoutMs: 5000, maxRetries: 0 });
    const secretStore = createInMemorySecretStore();

    secretStore.set('ctrlztree.ai.key.openai-chat-compatible', 'test-key');

    const mockFetch = overrides?.fetchFn || (async (_url: string, _init?: any) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
            choices: [{
                message: {
                    content: JSON.stringify({
                        task: 'summarize_node', baseSeq: 0,
                        nodeUpdates: [], operationPlan: [], warnings: []
                    })
                }
            }]
        }),
    }));

    registry.register('openai-chat-compatible', new BaseAiProvider(
        'openai-chat-compatible',
        createDefaultCapabilities('openai-chat-compatible'),
        'https://api.example.com/v1/chat/completions',
        openaiChatCompatibleHooks,
        mockFetch,
    ));

    registry.register('anthropic-messages', new BaseAiProvider(
        'anthropic-messages',
        createDefaultCapabilities('anthropic-messages'),
        'https://api.anthropic.com/v1/messages',
        anthropicMessagesHooks,
        mockFetch,
    ));

    registry.register('openai-responses', new BaseAiProvider(
        'openai-responses',
        createDefaultCapabilities('openai-responses'),
        'https://api.openai.com/v1/responses',
        openaiResponsesHooks,
        mockFetch,
    ));

    registry.register('custom-http-json', new BaseAiProvider(
        'custom-http-json',
        createDefaultCapabilities('custom-http-json'),
        'https://api.example.com/v1',
        customHttpJsonHooks,
        mockFetch,
    ));

    return new AiService({ registry, scheduler, secretStore });
}

function makeValidConfig(overrides?: Partial<ClampedAiConfig>): ClampedAiConfig {
    return {
        enabled: true,
        provider: 'openai-chat-compatible',
        model: 'test-model',
        baseUrl: 'https://api.example.com/v1/chat/completions',
        valid: true,
        errors: [],
        ...overrides,
    };
}

suite('AiService', () => {
    suite('testConnection', () => {
        test('succeeds when config is valid and fetch returns ok', async () => {
            const svc = makeAiService();
            const result = await svc.testConnection(makeValidConfig());
            assert.strictEqual(result.ok, true);
        });

        test('fails when config is invalid', async () => {
            const svc = makeAiService();
            const result = await svc.testConnection({
                ...makeValidConfig(),
                valid: false,
                errors: ['Invalid provider'],
            });
            assert.strictEqual(result.ok, false);
            assert.ok(result.error?.includes('Invalid'));
        });

        test('fails when api key is missing', async () => {
            const svc = makeAiService();
            const config = makeValidConfig({ provider: 'anthropic-messages', model: 'test' });
            const result = await svc.testConnection(config);
            assert.strictEqual(result.ok, false);
            assert.ok(result.error?.includes('No API key'), `expected 'No API key' error, got: ${result.error}`);
        });

        test('fails when provider returns error', async () => {
            const errorFetch = async () => ({
                ok: false,
                status: 401,
                text: async () => JSON.stringify({ error: { message: 'Unauthorized' } }),
            });
            const svc = makeAiService({ fetchFn: errorFetch });

            const secretStore = createInMemorySecretStore();
            await secretStore.set('ctrlztree.ai.key.openai-chat-compatible', 'test-key');

            const registry = new ProviderRegistry();
            registry.register('openai-chat-compatible', new BaseAiProvider(
                'openai-chat-compatible',
                createDefaultCapabilities('openai-chat-compatible'),
                'https://api.example.com',
                openaiChatCompatibleHooks,
                errorFetch as any,
            ));

            const svc2 = new AiService({
                registry,
                scheduler: new RequestScheduler({ maxConcurrentRequests: 5, maxRequestsPerHour: 1000, timeoutMs: 5000, maxRetries: 0 }),
                secretStore,
            });
            const result = await svc2.testConnection(makeValidConfig());
            assert.strictEqual(result.ok, false);
            assert.ok(result.error?.includes('Authentication'));
        });

        test('fails when provider is not registered', async () => {
            const registry = new ProviderRegistry();
            const svc = new AiService({
                registry,
                scheduler: new RequestScheduler({ maxConcurrentRequests: 5, maxRequestsPerHour: 1000, timeoutMs: 5000, maxRetries: 0 }),
                secretStore: createInMemorySecretStore(),
            });
            const result = await svc.testConnection(makeValidConfig());
            assert.strictEqual(result.ok, false);
            assert.ok(result.error?.includes('Unknown provider') || result.error?.includes('No API key'));
        });
    });

    suite('sendRequest', () => {
        const mockSendFetch = async (_url: string, _init?: any) => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            task: 'summarize_node', baseSeq: 0,
                            nodeUpdates: [], operationPlan: [], warnings: []
                        })
                    }
                }]
            }),
        });

        test('sends request through scheduler and returns response', async () => {
            const secretStore = createInMemorySecretStore();
            await secretStore.set('ctrlztree.ai.key.openai-chat-compatible', 'test-key');

            const registry = new ProviderRegistry();
            registry.register('openai-chat-compatible', new BaseAiProvider(
                'openai-chat-compatible',
                createDefaultCapabilities('openai-chat-compatible'),
                'https://api.example.com',
                openaiChatCompatibleHooks,
                mockSendFetch,
            ));
            const svc = new AiService({
                registry,
                scheduler: new RequestScheduler({ maxConcurrentRequests: 5, maxRequestsPerHour: 1000, timeoutMs: 5000, maxRetries: 0 }),
                secretStore,
            });

            const result = await svc.sendRequest('test-doc', makeValidConfig(), {
                task: 'summarize_node',
                model: 'test',
                system: '',
                messages: [{ role: 'user', content: 'Hi' }],
                metadata: { promptVersion: 'test', docFingerprint: 'test', headNodeId: 0, baseSeq: 0 },
            });
            assert.ok(result);
            assert.ok(!('ok' in result) || (result as any).ok !== false, 'should not be an error response');
        });
    });

    suite('provider registry', () => {
        test('all four providers are registered', () => {
            const svc = makeAiService();
            const registry = svc.getRegistry();
            for (const name of ['openai-chat-compatible', 'anthropic-messages', 'openai-responses', 'custom-http-json'] as ProviderName[]) {
                assert.ok(registry.has(name), `provider ${name} should be registered`);
            }
        });
    });
});
