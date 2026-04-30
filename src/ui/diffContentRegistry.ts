import * as crypto from 'crypto';

export interface DiffRecord {
	original: string;
	modified: string;
	title: string;
	createdAt: number;
}

export interface DiffContentRegistry {
	register(original: string, modified: string, title?: string): string;
	get(id: string): DiffRecord | undefined;
	delete(id: string): void;
	clear(): void;
	readonly size: number;
}

export function createDiffContentRegistry(maxEntries?: number): DiffContentRegistry {
	const records = new Map<string, DiffRecord>();
	const effectiveMax = typeof maxEntries === 'number' && maxEntries > 0 ? maxEntries : 500;
	let nextSeq = 1;

	function generateId(): string {
		const seq = nextSeq++;
		const timestamp = Date.now().toString(36);
		const rand = crypto.randomBytes(4).toString('hex');
		return `dcr_${timestamp}_${rand}_${seq}`;
	}

	function evictOldest(): void {
		if (records.size <= effectiveMax) {
			return;
		}

		let oldestId: string | null = null;
		let oldestTime = Infinity;

		for (const [id, record] of records) {
			if (record.createdAt < oldestTime) {
				oldestTime = record.createdAt;
				oldestId = id;
			}
		}

		if (oldestId) {
			records.delete(oldestId);
		}
	}

	const registry: DiffContentRegistry = {
		register(original: string, modified: string, title?: string): string {
			const id = generateId();
			records.set(id, {
				original,
				modified,
				title: title || 'Diff',
				createdAt: Date.now()
			});
			evictOldest();
			return id;
		},

		get(id: string): DiffRecord | undefined {
			return records.get(id);
		},

		delete(id: string): void {
			records.delete(id);
		},

		clear(): void {
			records.clear();
		},

		get size(): number {
			return records.size;
		}
	};

	return registry;
}
