export interface SchedulerConfig {
	maxConcurrentRequests: number;
	maxRequestsPerHour: number;
	timeoutMs: number;
	maxRetries: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
	maxConcurrentRequests: 1,
	maxRequestsPerHour: 30,
	timeoutMs: 15000,
	maxRetries: 2,
};

export interface ScheduledRequest<T> {
	docId: string;
	label: string;
	execute: (signal: AbortSignal) => Promise<T>;
	isRetryable?: (error: unknown) => boolean;
}

export interface SchedulerStats {
	concurrent: number;
	queued: number;
	totalCompleted: number;
	totalFailed: number;
	totalRetried: number;
}

interface QueuedItem {
	req: ScheduledRequest<unknown>;
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
}

export class RequestScheduler {
	private concurrent = 0;
	private queue: QueuedItem[] = [];
	private controllers = new Map<string, Set<AbortController>>();
	private rateTimestamps: number[] = [];
	private totalCompleted = 0;
	private totalFailed = 0;
	private totalRetried = 0;

	constructor(private config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG) {}

	async schedule<T>(req: ScheduledRequest<T>): Promise<T> {
		if (this.concurrent >= this.config.maxConcurrentRequests || this.queue.length > 0) {
			return new Promise<T>((resolve, reject) => {
				this.queue.push({
					req: req as ScheduledRequest<unknown>,
					resolve: resolve as (v: unknown) => void,
					reject
				});
			});
		}

		return this.executeRequest(req, 0);
	}

	cancelByDoc(docId: string, reason: string): void {
		const controllers = this.controllers.get(docId);
		if (controllers) {
			for (const ctrl of controllers) {
				try { ctrl.abort(reason); } catch { /* ignore already-aborted */ }
			}
			this.controllers.delete(docId);
		}

		const cancelErr = new Error(`Request cancelled: ${reason}`);
		this.queue = this.queue.filter(item => {
			if (item.req.docId === docId) {
				item.reject(cancelErr);
				return false;
			}
			return true;
		});
	}

	getStats(): SchedulerStats {
		return {
			concurrent: this.concurrent,
			queued: this.queue.length,
			totalCompleted: this.totalCompleted,
			totalFailed: this.totalFailed,
			totalRetried: this.totalRetried
		};
	}

	private async executeRequest<T>(req: ScheduledRequest<T>, retryCount: number): Promise<T> {
		// Only increment concurrent on first attempt; retries reuse the slot
		const isRetry = retryCount > 0;
		if (!isRetry) {
			this.concurrent++;
		}

		const controller = new AbortController();
		this.addController(req.docId, controller);

		let timedOut = false;
		const timeoutId = setTimeout(() => {
			timedOut = true;
			try { controller.abort('Request timeout'); } catch { /* ignore */ }
		}, this.config.timeoutMs);

		try {
			await this.waitForRateLimit(controller.signal);

			const result = await req.execute(controller.signal);

			clearTimeout(timeoutId);

			// Check if result itself is a retryable error (provider returns error objects, not throws)
			if (req.isRetryable && req.isRetryable(result)) {
				if (retryCount < this.config.maxRetries) {
					this.totalRetried++;
					return this.retryRequest(req, retryCount);
				}
				throw new Error(`Request failed after ${retryCount + 1} attempt(s)`);
			}

			this.recordRateTimestamp();
			this.totalCompleted++;
			return result;
		} catch (error: unknown) {
			clearTimeout(timeoutId);

			if (timedOut) {
				this.totalFailed++;
				if (retryCount < this.config.maxRetries) {
					this.totalRetried++;
					return this.retryRequest(req, retryCount);
				}
				throw new Error(`Request timed out after ${retryCount + 1} attempt(s)`);
			}

			if (controller.signal.aborted) {
				this.totalFailed++;
				throw error; // User cancelled or other abort — don't retry
			}

			this.totalFailed++;
			if (retryCount < this.config.maxRetries && isRetryableHttpError(error)) {
				this.totalRetried++;
				return this.retryRequest(req, retryCount);
			}

			throw error;
		} finally {
			this.removeController(req.docId, controller);
			if (!isRetry) {
				this.concurrent--;
			}
			this.drainQueue();
		}
	}

	private async retryRequest<T>(req: ScheduledRequest<T>, retryCount: number): Promise<T> {
		const baseMs = this.config.timeoutMs > 1000 ? 1000 : Math.max(10, this.config.timeoutMs / 2);
		const delay = Math.min(baseMs * Math.pow(2, retryCount), 3000);
		// retry sleep supports cancellation via abort signal
		const controller = new AbortController();
		// Link to doc's controller set for cancellation during sleep
		let docSet = this.controllers.get(req.docId);
		if (!docSet) {
			docSet = new Set();
			this.controllers.set(req.docId, docSet);
		}
		docSet.add(controller);
		try {
			await abortAwareSleep(delay + Math.random() * 100, controller.signal);
		} catch {
			// Aborted during retry sleep — don't retry
			throw new Error(`Retry cancelled: ${req.docId}`);
		} finally {
			docSet.delete(controller);
			if (docSet.size === 0) {
				this.controllers.delete(req.docId);
			}
		}
		// Note: executeRequest increments concurrent — retry stays within the original
		// request lifecycle so the concurrent cap is preserved.
		return this.executeRequest(req, retryCount + 1);
	}

	private drainQueue(): void {
		while (this.queue.length > 0 && this.concurrent < this.config.maxConcurrentRequests) {
			const next = this.queue.shift()!;
			this.executeRequest(next.req, 0)
				.then(next.resolve)
				.catch(next.reject);
		}
	}

	private addController(docId: string, ctrl: AbortController): void {
		let set = this.controllers.get(docId);
		if (!set) {
			set = new Set();
			this.controllers.set(docId, set);
		}
		set.add(ctrl);
	}

	private removeController(docId: string, ctrl: AbortController): void {
		const set = this.controllers.get(docId);
		if (!set) {return;}
		set.delete(ctrl);
		if (set.size === 0) {
			this.controllers.delete(docId);
		}
	}

	private async waitForRateLimit(signal?: AbortSignal): Promise<void> {
		const maxPerHour = Math.max(1, this.config.maxRequestsPerHour);
		const now = Date.now();
		const oneHourAgo = now - 3600000;

		this.rateTimestamps = this.rateTimestamps.filter(t => t > oneHourAgo);

		if (this.rateTimestamps.length >= maxPerHour) {
			const oldest = this.rateTimestamps[0];
			const waitMs = oldest - oneHourAgo;
			if (waitMs > 0) {
				await abortAwareSleep(waitMs, signal);
				this.rateTimestamps = this.rateTimestamps.filter(t => t > Date.now() - 3600000);
			}
		}
	}

	private recordRateTimestamp(): void {
		this.rateTimestamps.push(Date.now());
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function abortAwareSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal || ms <= 0) {
		return sleep(ms);
	}
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error('Aborted during wait'));
			return;
		}
		const timer = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('Aborted during wait'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function isRetryableHttpError(error: unknown): boolean {
	if (error && typeof error === 'object') {
		const e = error as Record<string, unknown>;
		if (typeof e.statusCode === 'number') {
			return e.statusCode === 429 || (e.statusCode >= 500 && e.statusCode < 600);
		}
		if (typeof e.message === 'string') {
			const msg = e.message.toLowerCase();
			return msg.includes('fetch') || msg.includes('network') || msg.includes('econnrefused') || msg.includes('enotfound');
		}
	}
	return false;
}
