import { ProviderRegistry, ProviderName } from './providers/registry';
import { RequestScheduler, SchedulerConfig, DEFAULT_SCHEDULER_CONFIG } from '../concurrency/requestScheduler';
import { SecretStore } from '../security/secretStore';
import { ClampedAiConfig } from '../config/configService';
import { UnifiedAiRequest, UnifiedAiResponse, AiProviderError } from './types';
import { redactSensitiveData } from './redactor';

export interface AiServiceDeps {
	registry: ProviderRegistry;
	scheduler: RequestScheduler;
	secretStore: SecretStore;
	schedulerConfig?: SchedulerConfig;
}

export interface TestConnectionResult {
	ok: boolean;
	statusCode?: number;
	error?: string;
}

export class AiService {
	private registry: ProviderRegistry;
	private scheduler: RequestScheduler;
	private secretStore: SecretStore;

	constructor(deps: AiServiceDeps) {
		this.registry = deps.registry;
		this.scheduler = deps.scheduler;
		this.secretStore = deps.secretStore;
	}

	async testConnection(config: ClampedAiConfig): Promise<TestConnectionResult> {
		if (!config.valid) {
			return { ok: false, error: config.errors.join('; ') };
		}

		const provider = this.registry.get(config.provider as ProviderName);
		if (!provider) {
			return { ok: false, error: `Unknown provider: ${config.provider}` };
		}

		const storageKey = `ctrlztree.ai.key.${config.provider}`;
		const apiKey = await this.secretStore.get(storageKey);
		if (!apiKey) {
			return { ok: false, error: `No API key configured for ${config.provider}` };
		}

		const request: UnifiedAiRequest = {
			task: 'summarize_node',
			model: config.model,
			system: '',
			messages: [{ role: 'user', content: 'Hi' }],
			responseSchema: { type: 'object', properties: {} },
			maxOutputTokens: 16,
			temperature: 0,
			topP: 1,
			toolMode: 'none',
			parallelToolCalls: false,
			metadata: {
				promptVersion: 'test',
				docFingerprint: 'test',
				headNodeId: 0,
				baseSeq: 0,
			},
		};

		try {
			await this.scheduler.schedule({
				docId: 'ai-test-connection',
				label: 'test-connection',
				execute: async (signal) => {
					const result = await provider.sendRequest(request, apiKey, signal);
					if (!('ok' in result) || result.ok !== false) {
						return result;
					}
					const err = result as AiProviderError;
					throw Object.assign(new Error(err.error), { statusCode: err.statusCode });
				},
			});
			return { ok: true };
		} catch (e: any) {
			const redacted = redactSensitiveData(e.message || 'Unknown error');
			const statusCode = e.statusCode as number | undefined;
			if (statusCode === 401 || statusCode === 403) {
				return { ok: false, error: `Authentication failed (${statusCode}). Check your API key.`, statusCode };
			}
			if (e.message?.includes('timeout') || e.message?.includes('Aborted')) {
				return { ok: false, error: `Connection timed out. Check your network and endpoint.` };
			}
			return { ok: false, error: redacted.redacted.substring(0, 200) };
		}
	}

	async sendRequest(
		docId: string,
		config: ClampedAiConfig,
		request: UnifiedAiRequest,
	): Promise<UnifiedAiResponse | AiProviderError> {
		if (!config.valid) {
			return { ok: false, error: config.errors.join('; '), retryable: false };
		}

		const provider = this.registry.get(config.provider as ProviderName);
		if (!provider) {
			return { ok: false, error: `Unknown provider: ${config.provider}`, retryable: false };
		}

		const storageKey = `ctrlztree.ai.key.${config.provider}`;
		const apiKey = await this.secretStore.get(storageKey);
		if (!apiKey) {
			return { ok: false, error: `No API key configured for ${config.provider}`, retryable: false };
		}

		const label = `ai-${request.task}`;
		return this.scheduler.schedule({
			docId,
			label,
			execute: async (signal) => {
				return provider.sendRequest(request, apiKey, signal);
			},
		});
	}

	getScheduler(): RequestScheduler {
		return this.scheduler;
	}

	getRegistry(): ProviderRegistry {
		return this.registry;
	}
}
