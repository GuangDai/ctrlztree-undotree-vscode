import * as vscode from 'vscode';
import { HistoryController } from '../history/historyController';
import { CtrlZTree, TreeNode } from '../model/ctrlZTree';
import { NodeView } from '../history/projection';

export class HistoryTreeItem extends vscode.TreeItem {
	// Used internally to track tree depth (not part of TreeItem API)
		// eslint-disable-next-line @typescript-eslint/naming-convention
	public __depth = 0;

	constructor(
		public readonly nodeHash: string,
		label: string,
		description: string,
		tooltip: string,
		public readonly isHead: boolean,
		public readonly isBranchChild: boolean,
		hasChildren: boolean,
		docUri?: string
	) {
		super(
			label,
			hasChildren
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None
		);

		this.description = description;
		this.tooltip = tooltip;
		this.id = docUri ? `${docUri}:${nodeHash}` : nodeHash;

		// Use standard ThemeIcons without hardcoded colors for cross-theme readability.
		// The label prefix (↱ / ↳) provides the semantic distinction; icons are fallback.
		if (isHead) {
			this.iconPath = new vscode.ThemeIcon('circle-filled');
		} else if (isBranchChild) {
			this.iconPath = new vscode.ThemeIcon('arrow-small-right');
		} else {
			this.iconPath = new vscode.ThemeIcon('circle-outline');
		}

		this.contextValue = isHead
			? 'ctrlztree.node.head'
			: isBranchChild
				? 'ctrlztree.node.branchChild'
				: 'ctrlztree.node.branchTip';
	}
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryTreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<HistoryTreeItem | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _controller: HistoryController | null = null;
	private docUri: string | null = null;

	// Backward-compat getter: all existing code that uses this.tree continues to work
	private get tree(): CtrlZTree | null {
		return this._controller?.getTree() ?? null;
	}

	setController(controller: HistoryController | null, docUri: string): void {
		this._controller = controller;
		this.docUri = docUri;
		this._onDidChangeTreeData.fire();
	}

	clear(): void {
		this._controller = null;
		this.docUri = null;
		this._onDidChangeTreeData.fire();
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	/** Resolve a CtrlZTree hash to the projection's NodeView for AI name/summary/timestamp lookups. */
	private getNodeView(hash: string): NodeView | undefined {
		if (!this._controller) { return undefined; }
		const nodeId = this._controller.getNodeIdByHash(hash);
		if (nodeId === undefined) { return undefined; }
		return this._controller.getProjection().byId.get(nodeId);
	}

	/** Check whether a node is archived or deleted in the projection. */
	private isArchivedOrDeleted(hash: string): boolean {
		if (!this._controller) { return false; }
		const nodeId = this._controller.getNodeIdByHash(hash);
		if (nodeId === undefined) { return false; }
		const proj = this._controller.getProjection();
		return proj.archivedNodes.has(nodeId) || proj.deletedNodes.has(nodeId);
	}

	getTreeItem(element: HistoryTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: HistoryTreeItem): vscode.ProviderResult<HistoryTreeItem[]> {
		if (!this.tree) { return []; }
		const allNodes = this.tree.getAllNodes();
		const rootHash = this.tree.getInternalRootHash();

		if (!element) {
			// Root level: start from HEAD, walk up ancestor chain,
			// inline until we hit a branch point.
			return this.buildBranchedTimeline(this.tree, allNodes, rootHash);
		}

		// Children of a branch-point node: show its ancestors + sibling branches
		const childDepth = (element.__depth ?? 0) + 1;
		return this.buildBranchChildren(this.tree, allNodes, element.nodeHash, rootHash, childDepth);
	}

	/**
	 * Build the top-level tree: walk from HEAD up through ancestors.
	 * Linear segments (0 or 1 child) are flattened into a chain at the root level.
	 * Only branch points (nodes with &gt;1 child) create nested tree levels.
	 */
	private buildBranchedTimeline(
		tree: CtrlZTree,
		allNodes: Map<string, TreeNode>,
		rootHash: string
	): HistoryTreeItem[] {
		const items: HistoryTreeItem[] = [];
		const head = tree.getHead();
		if (!head) { return items; }

		const visited = new Set<string>();
		let cursor: string | null = head;

		while (cursor && !visited.has(cursor)) {
			const node = allNodes.get(cursor);
			if (!node) { break; }
			visited.add(cursor);

			// Skip internal empty root
			if (cursor === rootHash) { break; }

			const childCount = node.children.length;
			const isHead = cursor === head;
			const isBranchPoint = childCount > 1;

			if (isBranchPoint) {
				// This node has multiple children → it forms a tree level.
				// Show it as a collapsible branch point.
				const item = this.makeItem(tree, allNodes, cursor, rootHash, isHead, false);
				items.push(item);
				// Continue the linear chain from this node's parent as next root-level item
				cursor = node.parent;
				continue;
			}

			// Linear node → show as a flat item in the root level
			const item = this.makeItem(tree, allNodes, cursor, rootHash, isHead, false);
			items.push(item);

			cursor = node.parent;
		}

		return items;
	}

	/**
	 * Children of a branch-point node: show its parent (ancestor) + its redo children.
	 */
	private buildBranchChildren(
		tree: CtrlZTree,
		allNodes: Map<string, TreeNode>,
		nodeHash: string,
		rootHash: string,
		depth: number
	): HistoryTreeItem[] {
		const maxDepth = vscode.workspace.getConfiguration('ctrlztree').get<number>('treeView.maxDepth', 4);
		if (depth > maxDepth) { return []; }

		const items: HistoryTreeItem[] = [];
		const node = allNodes.get(nodeHash);
		if (!node) { return items; }

		// 1. Parent (ancestor direction) — continue the undo chain
		if (node.parent && node.parent !== rootHash) {
			const parentNode = allNodes.get(node.parent);
			if (parentNode) {
				const item = this.makeItem(tree, allNodes, node.parent, rootHash, false, false);
				item.__depth = depth;
				items.push(item);
			}
		}

		// 2. Redo children (branch directions)
		for (const childHash of node.children) {
			if (childHash === nodeHash) { continue; }
			const childNode = allNodes.get(childHash);
			if (!childNode) { continue; }
			const item = this.makeItem(tree, allNodes, childHash, rootHash, false, true);
			item.__depth = depth;
			items.push(item);
		}

		return items;
	}

	private makeItem(
		tree: CtrlZTree,
		allNodes: Map<string, TreeNode>,
		hash: string,
		rootHash: string,
		isHead: boolean,
		isBranchChild: boolean
	): HistoryTreeItem {
		const node = allNodes.get(hash)!;
		const nodeView = this.getNodeView(hash);
		const isArchived = this.isArchivedOrDeleted(hash);
		const aiName = nodeView?.name;
		const aiSummary = nodeView?.summary;
		const showAiLabels = vscode.workspace.getConfiguration('ctrlztree').get<boolean>('treeView.showAiLabels', true);

		const content = tree.getContent(hash);
		const shortHash = hash.substring(0, 8);
		const firstLine = content.split('\n')[0] || '(empty)';
		const previewLen = vscode.workspace.getConfiguration('ctrlztree').get<number>('treeView.previewLength', 50);
		const preview = firstLine.length > previewLen ? firstLine.substring(0, previewLen - 3) + '...' : firstLine;
		const showTimestamp = vscode.workspace.getConfiguration('ctrlztree').get<boolean>('treeView.showTimestamps', true);
		const showHash = vscode.workspace.getConfiguration('ctrlztree').get<boolean>('treeView.showHashPreview', true);

		// Use projection createdAt for correct historical timestamps, fall back to legacy tree node
		const displayTimestamp = nodeView?.createdAt ?? node.timestamp;
		const timestamp = showTimestamp ? new Date(displayTimestamp).toLocaleTimeString() : '';

		const childCount = node.children.length;
		const isBranchPoint = childCount > 1;

		// Label: prefer AI name over content preview
		let label: string;
		const prefix = isHead ? '●' : isBranchChild ? '↱' : '↳';
		if (showAiLabels && aiName) {
			label = `${prefix} ${aiName}`;
		} else {
			label = `${prefix} ${preview}`;
		}

		// Description: right-aligned metadata
		let desc = '';
		if (showTimestamp) { desc += timestamp; }
		if (showHash) { desc += (desc ? ' — ' : '') + shortHash; }
		// When AI name is shown, put content preview in description
		if (showAiLabels && aiName) {
			desc += (desc ? ' • ' : '') + preview;
		}
		if (isArchived) { desc += ' [archived]'; }
		if (isBranchPoint) {
			desc += ` [+${childCount} branches]`;
		}

		// Has children in tree view if it's a branch point OR if it has a parent (ancestor to expand into)
		const hasChildren = !isArchived && (isBranchPoint || (node.parent !== null && node.parent !== rootHash));

		let tooltip = `${isHead ? '● HEAD' : isBranchChild ? '↱ Branch' : '↳ Ancestor'} — ${timestamp}`;
		tooltip += `\nHash: ${hash.substring(0, 12)}`;
		if (aiName) { tooltip += `\nName: ${aiName}`; }
		if (aiSummary) { tooltip += `\nSummary: ${aiSummary}`; }
		if (childCount > 1) { tooltip += `\n${childCount} redo branches`; }
		if (isArchived) { tooltip += '\n(Archived)'; }
		tooltip += `\n${firstLine}`;

		const item = new HistoryTreeItem(
			hash,
			label,
			desc,
			tooltip,
			isHead,
			isBranchChild,
			hasChildren,
			this.docUri ?? undefined
		);

		// Archived nodes: greyed out icon, non-collapsible
		if (isArchived) {
			item.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
			item.collapsibleState = vscode.TreeItemCollapsibleState.None;
		}

		return item;
	}
}
