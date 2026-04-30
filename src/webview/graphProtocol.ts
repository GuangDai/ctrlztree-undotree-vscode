export const GRAPH_PROTOCOL_VERSION = 2;

export interface GraphNode {
	id: string;
	label: string;
	title: string;
	hasParent: boolean;
	baseLabel: string;
}

export interface GraphEdge {
	from: string;
	to: string;
}

// --- Outgoing messages (extension -> webview) ---

export interface GraphInitMessage {
	command: 'graphInit';
	protocolVersion: number;
	nodes: GraphNode[];
	edges: GraphEdge[];
	headId: string | null;
}

export interface GraphPatchMessage {
	command: 'graphPatch';
	added: GraphNode[];
	removed: string[];       // node ids
	updated: GraphNode[];     // changed nodes (full replacement)
	addedEdges: GraphEdge[];
	removedEdges: GraphEdge[];
	headId?: string | null;
}

export interface GraphSelectMessage {
	command: 'graphSelect';
	nodeId: string;
}

export interface GraphExpandMessage {
	command: 'graphExpand';
	nodeId: string;
	children: GraphNode[];
	edges: GraphEdge[];
}

export type GraphOutMessage =
	| GraphInitMessage
	| GraphPatchMessage
	| GraphSelectMessage
	| GraphExpandMessage
	| { command: 'updateTheme' };

// --- Legacy message (backward compat) ---

export interface UpdateTreeMessage {
	command: 'updateTree';
	nodes: GraphNode[];
	edges: GraphEdge[];
	headShortHash: string | null;
}

// --- Protocol helpers ---

export function isGraphOutMessage(payload: unknown): payload is GraphOutMessage {
	if (typeof payload !== 'object' || payload === null) {return false;}
	const msg = payload as Record<string, unknown>;
	switch (msg.command) {
		case 'graphInit':
			return typeof msg.protocolVersion === 'number'
				&& Array.isArray(msg.nodes)
				&& Array.isArray(msg.edges);
		case 'graphPatch':
			return Array.isArray(msg.added)
				&& Array.isArray(msg.removed)
				&& Array.isArray(msg.updated)
				&& Array.isArray(msg.addedEdges)
				&& Array.isArray(msg.removedEdges);
		case 'graphSelect':
			return typeof msg.nodeId === 'string';
		case 'graphExpand':
			return typeof msg.nodeId === 'string'
				&& Array.isArray(msg.children)
				&& Array.isArray(msg.edges);
		case 'updateTheme':
			return true;
		default:
			return false;
	}
}
