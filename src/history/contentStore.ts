import { NodeId } from './ids';
import { ContentRef } from './events';
import { Projection } from './projection';
import { generateDiff, applyDiff, serializeDiff, deserializeDiff, DiffOperation } from '../lcs';

export interface SnapshotPolicy {
	snapshotEveryNodes: number;
	snapshotInlineThresholdBytes: number;
	maxDiffDocumentBytes: number;
	maxContentBytesTracked: number;
}

export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicy = {
	snapshotEveryNodes: 32,
	snapshotInlineThresholdBytes: 8192,
	maxDiffDocumentBytes: 4194304,
	maxContentBytesTracked: 10485760,
};

interface StoredEntry {
	contentRef: ContentRef;
	diff?: string;
	snapshot?: string;
}

interface LruCacheEntry {
	content: string;
	lastAccess: number;
}

export class MemoryContentStore {
	private entries = new Map<NodeId, StoredEntry>();
	private cache = new Map<NodeId, LruCacheEntry>();
	private cacheSize = 0;
	private maxCacheEntries: number;
	private nodeCount = 0;

	constructor(maxCacheEntries = 64) {
		this.maxCacheEntries = maxCacheEntries;
	}

	appendEdit(parentContent: string, nextContent: string, nodeId: NodeId, policy: SnapshotPolicy = DEFAULT_SNAPSHOT_POLICY): ContentRef {
		this.nodeCount++;

		const diff = nextContent.length - parentContent.length;
		const diffStr = serializeDiff(generateDiff(parentContent, nextContent));
		const diffBytes = Buffer.byteLength(diffStr, 'utf8');

		const shouldSnapshot = this.nodeCount % policy.snapshotEveryNodes === 0
			|| nextContent.length > policy.maxDiffDocumentBytes
			|| diffBytes > policy.snapshotInlineThresholdBytes;

		if (shouldSnapshot) {
			const ref: ContentRef = { kind: 'snapshot', nodeId, bytes: Buffer.byteLength(nextContent, 'utf8') };
			this.entries.set(nodeId, { contentRef: ref, snapshot: nextContent });
			return ref;
		}

		const ref: ContentRef = { kind: 'inline-diff', nodeId, bytes: diffBytes };
		this.entries.set(nodeId, { contentRef: ref, diff: diffStr });
		return ref;
	}

	resolve(nodeId: NodeId, projection: Projection): string | null {
		// Check cache first
		const cached = this.cache.get(nodeId);
		if (cached) {
			cached.lastAccess = Date.now();
			return cached.content;
		}

		// Walk from nodeId to root, collecting diffs
		const path: NodeId[] = [];
		let current = nodeId;
		while (current !== undefined) {
			const parent = projection.parentOf.get(current);
			if (parent === undefined) {
				return null; // node not in projection
			}
			path.push(current);
			if (parent === null) {
				break; // reached root
			}
			current = parent;
		}

		// Path is now from nodeId backwards to root
		// Start from root content, apply diffs forward
		let content = '';
		let resolved = false;

		for (let i = path.length - 1; i >= 0; i--) {
			const id = path[i];
			const entry = this.entries.get(id);

			if (!entry) {
				return null;
			}

			if (entry.snapshot !== undefined) {
				content = entry.snapshot;
				resolved = true;
				continue;
			}

			if (!resolved) {
				return null; // no snapshot found to start from
			}

			if (entry.diff !== undefined) {
				const ops = deserializeDiff(entry.diff);
				content = applyDiff(content, ops);
			}
		}

		if (!resolved) {
			return null;
		}

		// Store in cache
		this.cacheSet(nodeId, content);
		return content;
	}

	tryResolve(nodeId: NodeId, projection: Projection): { ok: true; content: string } | { ok: false; error: string } {
		const content = this.resolve(nodeId, projection);
		if (content === null) {
			return { ok: false, error: `Cannot resolve content for node ${nodeId}` };
		}
		return { ok: true, content };
	}

	hasSnapshot(nodeId: NodeId): boolean {
		const entry = this.entries.get(nodeId);
		return entry?.snapshot !== undefined;
	}

	clearCacheFor(nodeId: NodeId): void {
		const cached = this.cache.get(nodeId);
		if (cached) {
			this.cacheSize -= Buffer.byteLength(cached.content, 'utf8');
			this.cache.delete(nodeId);
		}
	}

	getEntryCount(): number {
		return this.entries.size;
	}

	getCacheSize(): number {
		return this.cacheSize;
	}

	private cacheSet(nodeId: NodeId, content: string): void {
		// Evict if full
		while (this.cache.size >= this.maxCacheEntries) {
			this.evictOne();
		}

		const oldEntry = this.cache.get(nodeId);
		if (oldEntry) {
			this.cacheSize -= Buffer.byteLength(oldEntry.content, 'utf8');
		}

		this.cache.set(nodeId, { content, lastAccess: Date.now() });
		this.cacheSize += Buffer.byteLength(content, 'utf8');
	}

	private evictOne(): void {
		let oldestKey: NodeId | null = null;
		let oldestTime = Infinity;

		for (const [key, entry] of this.cache) {
			if (entry.lastAccess < oldestTime) {
				oldestTime = entry.lastAccess;
				oldestKey = key;
			}
		}

		if (oldestKey !== null) {
			const entry = this.cache.get(oldestKey);
			if (entry) {
				this.cacheSize -= Buffer.byteLength(entry.content, 'utf8');
			}
			this.cache.delete(oldestKey);
		}
	}
}
