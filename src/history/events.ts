import { NodeId, EventSeq, TxId, ContentHash, Cursor } from './ids';

export interface ContentRef {
	kind: 'inline-diff' | 'snapshot' | 'external';
	nodeId?: NodeId;
	bytes: number;
	snapshotId?: number;
	ref?: string;
}

export interface FileSignature {
	mtime: number;
	size: number;
}

export interface AiProvenance {
	provider: string;
	model: string;
	confidence?: number;
}

export interface EventBase {
	schemaVersion: 1;
	seq: EventSeq;
	at: number;
	txId: TxId;
	source: 'user' | 'system' | 'ai-plan' | 'migration';
}

export interface InitEvent extends EventBase {
	kind: 'init';
	nodeId: NodeId;
	contentRef: ContentRef;
	contentHash: ContentHash;
	isNonEmpty: boolean;
	fileSig: FileSignature;
}

export interface EditEvent extends EventBase {
	kind: 'edit';
	nodeId: NodeId;
	parentId: NodeId;
	contentRef: ContentRef;
	contentHash: ContentHash;
	cursor?: Cursor;
	isNonEmpty: boolean;
	stats: {
		contentBytes: number;
		diffBytes: number;
		lineCount: number;
	};
}

export interface HeadMoveEvent extends EventBase {
	kind: 'headMove';
	from: NodeId;
	to: NodeId;
	reason: 'undo' | 'redo' | 'checkout' | 'restore' | 'ai-operation';
}

export interface RenameEvent extends EventBase {
	kind: 'rename';
	nodeId: NodeId;
	name: string;
	ai?: AiProvenance;
}

export interface SummarizeEvent extends EventBase {
	kind: 'summarize';
	nodeId: NodeId;
	summary: string;
	ai?: AiProvenance;
}

export interface ProtectEvent extends EventBase {
	kind: 'protect';
	nodeId: NodeId;
	protected: boolean;
	reason?: string;
}

export interface MergeEvent extends EventBase {
	kind: 'merge';
	sourceIds: NodeId[];
	resultId: NodeId;
	parentId: NodeId;
	contentRef: ContentRef;
	contentHash: ContentHash;
	archivedSourceIds: NodeId[];
	reason: string;
}

export interface PruneEvent extends EventBase {
	kind: 'prune';
	strategy: string;
	archivedIds: NodeId[];
	deletedIds: NodeId[];
	estimatedBytesFreed: number;
	warnings: string[];
}

export interface ArchiveEvent extends EventBase {
	kind: 'archive';
	nodeIds: NodeId[];
	reason: string;
}

export interface DeleteEvent extends EventBase {
	kind: 'delete';
	nodeIds: NodeId[];
	mode: 'soft' | 'hard';
	reason: string;
}

export interface ResetEvent extends EventBase {
	kind: 'reset';
	previousHeadId: NodeId;
	newRootId: NodeId;
	reason: string;
}

export type HistoryEvent =
	| InitEvent
	| EditEvent
	| HeadMoveEvent
	| RenameEvent
	| SummarizeEvent
	| ProtectEvent
	| MergeEvent
	| PruneEvent
	| ArchiveEvent
	| DeleteEvent
	| ResetEvent;
