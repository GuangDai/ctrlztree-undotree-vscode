export interface TaskToken {
	readonly cancelled: boolean;
	readonly cancelReason: string | null;
}

export class DocumentTaskQueue {
	private queues = new Map<string, Promise<unknown>>();
	private pendingCounts = new Map<string, number>();
	private cancelled = new Map<string, string>();
	private enqueuing = new Set<string>();

	async enqueue<T>(docId: string, label: string, task: () => Promise<T>): Promise<T> {
		if (this.enqueuing.has(docId)) {
			throw new Error(`Cannot enqueue task "${label}" for doc ${docId}: nested enqueue is not allowed.`);
		}

		this.enqueuing.add(docId);
		try {
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
					return await task();
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
		} finally {
			this.enqueuing.delete(docId);
		}
	}

	cancelPending(docId: string, reason: string): void {
		this.cancelled.set(docId, reason);
	}

	getPendingCount(docId: string): number {
		return this.pendingCounts.get(docId) ?? 0;
	}

	clear(docId: string): void {
		this.queues.delete(docId);
		this.pendingCounts.delete(docId);
		this.cancelled.delete(docId);
	}

	clearAll(): void {
		this.queues.clear();
		this.pendingCounts.clear();
		this.cancelled.clear();
		this.enqueuing.clear();
	}
}
