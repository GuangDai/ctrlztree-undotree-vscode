import { ProviderRegistry, ProviderName } from './providers/registry';
import { RequestScheduler, SchedulerConfig } from '../concurrency/requestScheduler';
import { SecretStore } from '../security/secretStore';
import { ClampedAiConfig } from '../config/configService';
import { UnifiedAiRequest, UnifiedAiResponse, AiProviderError } from './types';
import { redactSensitiveData } from './redactor';
import { Logger } from '../utils/logger';
import { validateAiResponse } from './operationPlanner';

export interface AiServiceDeps {
	registry: ProviderRegistry;
	scheduler: RequestScheduler;
	secretStore: SecretStore;
	logger?: Logger;
	schedulerConfig?: SchedulerConfig;
}

export interface TestConnectionResult {
	ok: boolean;
	statusCode?: number;
	error?: string;
	responseSummary?: string;
}

export class AiService {
	private registry: ProviderRegistry;
	private scheduler: RequestScheduler;
	private secretStore: SecretStore;
	private log: Logger;

	constructor(deps: AiServiceDeps) {
		this.registry = deps.registry;
		this.scheduler = deps.scheduler;
		this.secretStore = deps.secretStore;
		this.log = deps.logger ?? new Logger({ appendLine: () => {} } as any);
	}

	async testConnection(config: ClampedAiConfig): Promise<TestConnectionResult> {
		if (!config.valid) {
			this.log.error(`CtrlZTree AI: Invalid config: ${config.errors.join('; ')}`);
			return { ok: false, error: config.errors.join('; ') };
		}

		this.log.info(`CtrlZTree AI: Testing connection to ${config.provider} (${config.model}) via ${config.baseUrl}`);
		this.log.info(`CtrlZTree AI: Config valid=${config.valid} enabled=${config.enabled}`);

		const provider = this.registry.get(config.provider as ProviderName);
		if (!provider) {
			this.log.error(`CtrlZTree AI: Provider '${config.provider}' not found in registry. Registered: ${this.registry.list().join(', ')}`);
			return { ok: false, error: `Unknown provider: ${config.provider}` };
		}

		const storageKey = `ctrlztree.ai.key.${config.provider}`;
		const apiKey = await this.secretStore.get(storageKey);
		if (!apiKey) {
			this.log.error(`CtrlZTree AI: No API key found in SecretStorage for ${config.provider}`);
			return { ok: false, error: `No API key configured for ${config.provider}` };
		}
		this.log.debug(`CtrlZTree AI: API key found (length=${apiKey.length})`);

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
			const result = await this.scheduler.schedule({
				docId: 'ai-test-connection',
				label: 'test-connection',
				execute: async (signal) => {
					const resp = await provider.sendRequest(request, apiKey, signal, config.baseUrl || undefined);
					return resp;
				},
			});

			this.log.info(`CtrlZTree AI: Response received: ${JSON.stringify({
				task: (result as any).task,
				baseSeq: (result as any).baseSeq,
				nodeUpdates: (result as any).nodeUpdates?.length,
				warnings: (result as any).warnings,
			})}`);

			if (!('ok' in result) || result.ok !== false) {
				return { ok: true, responseSummary: JSON.stringify(result).substring(0, 300) };
			}
			const err = result as AiProviderError;
			this.log.warn(`CtrlZTree AI: Provider error: status=${err.statusCode} error=${err.error}`);
			throw Object.assign(new Error(err.error), { statusCode: err.statusCode });
		} catch (e: any) {
			this.log.error(`CtrlZTree AI: Test connection failed: ${e.message || 'Unknown'}`);
			const redacted = redactSensitiveData(e.message || 'Unknown error');
			const statusCode = e.statusCode as number | undefined;
			if (statusCode === 401 || statusCode === 403) {
				return { ok: false, error: `Authentication failed (${statusCode}). Check your API key.`, statusCode };
			}
			if (e.message?.includes('timeout') || e.message?.includes('Aborted') || e.message?.includes('aborted')) {
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
				const resp = await provider.sendRequest(request, apiKey, signal, config.baseUrl || undefined);
				// Validate AI response against projection (fail-closed)
				if (!('ok' in resp) || resp.ok !== false) {
					const proj = request.projection;
					if (proj) {
						const validation = validateAiResponse(resp, proj);
						if (!validation.valid) {
							return { ok: false, error: `AI response validation failed: ${validation.errors.join('; ')}`, retryable: false } as AiProviderError;
						}
					}
				}
				return resp;
			},
			isRetryable: (result: unknown) => {
				if (typeof result === 'object' && result !== null) {
					const r = result as Record<string, unknown>;
					if (r.ok === false && r.retryable === true) { return true; }
					if (r.ok === false && typeof r.statusCode === 'number') {
						return r.statusCode === 429 || (r.statusCode >= 500 && r.statusCode < 600);
					}
				}
				return false;
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
