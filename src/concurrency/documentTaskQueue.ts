export interface TaskToken {
	readonly cancelled: boolean;
	readonly cancelReason: string | null;
}

export class DocumentTaskQueue {
	private queues = new Map<string, Promise<unknown>>();
	private pendingCounts = new Map<string, number>();
	private cancelled = new Map<string, string>();
	private running = new Set<string>();
	private activeTokens = new Map<string, TaskTokenImpl>();

	async enqueue<T>(docId: string, label: string, task: (token: TaskToken) => Promise<T>): Promise<T> {
		if (this.running.has(docId)) {
			throw new Error(`Cannot enqueue task "${label}" for doc ${docId}: a task is already running for this document.`);
		}

		const previous = this.queues.get(docId);
		const currentCount = (this.pendingCounts.get(docId) ?? 0) + 1;
		this.pendingCounts.set(docId, currentCount);

		const run = async (): Promise<T> => {
			try {
				if (previous) {
					try {
						await previous;
					} catch {
						// Previous task failed; continue serialization
					}
				}
				if (this.cancelled.has(docId)) {
					throw new Error(`Task cancelled: ${this.cancelled.get(docId)}`);
				}
				this.running.add(docId);
				const token = new TaskTokenImpl(
					() => this.cancelled.has(docId),
					() => this.cancelled.get(docId) ?? null
				);
				this.activeTokens.set(docId, token);
				try {
					return await task(token);
				} finally {
					this.activeTokens.delete(docId);
					this.running.delete(docId);
				}
			} finally {
				const count = (this.pendingCounts.get(docId) ?? 1) - 1;
				if (count <= 0) {
					this.pendingCounts.delete(docId);
					this.cancelled.delete(docId);
				} else {
					this.pendingCounts.set(docId, count);
				}
			}
		};

		const promise = run();
		this.queues.set(docId, promise);
		return promise;
	}

	cancelPending(docId: string, reason: string): void {
		this.cancelled.set(docId, reason);
	}

	getPendingCount(docId: string): number {
		return this.pendingCounts.get(docId) ?? 0;
	}

	isCancelled(docId: string): boolean {
		return this.cancelled.has(docId);
	}

	clear(docId: string): void {
		this.queues.delete(docId);
		this.pendingCounts.delete(docId);
		this.cancelled.delete(docId);
		this.activeTokens.delete(docId);
	}

	clearAll(): void {
		this.queues.clear();
		this.pendingCounts.clear();
		this.cancelled.clear();
		this.running.clear();
		this.activeTokens.clear();
	}
}

class TaskTokenImpl implements TaskToken {
	constructor(
		private readonly isCancelledFn: () => boolean,
		private readonly reasonFn: () => string | null
	) {}

	get cancelled(): boolean {
		return this.isCancelledFn();
	}

	get cancelReason(): string | null {
		return this.reasonFn();
	}
}
