export type DocId = string;
export type NodeId = number;
export type EventSeq = number;
export type TxId = string;
export type ContentHash = string;

export interface Cursor {
	line: number;
	character: number;
}
