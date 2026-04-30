import * as vscode from 'vscode';
import { CtrlZTree } from '../model/ctrlZTree';

type HistoryTreeItemContext =
	| 'ctrlztree.node.head'
	| 'ctrlztree.node.branchTip'
	| 'ctrlztree.node.protected'
	| 'ctrlztree.node.archived'
	| 'ctrlztree.node.branch';

export class HistoryTreeItem extends vscode.TreeItem {
	constructor(
		public readonly nodeHash: string,
		public readonly labelStr: string,
		public readonly contextVal: HistoryTreeItemContext,
		public readonly childrenHashes?: string[],
		public readonly hasMore: boolean = false,
		docUri?: string
	) {
		super(labelStr, childrenHashes && childrenHashes.length > 0
			? vscode.TreeItemCollapsibleState.Collapsed
			: vscode.TreeItemCollapsibleState.None);

		this.contextValue = contextVal;
		this.tooltip = `${labelStr}\nNode: ${nodeHash.substring(0, 12)}`;
		this.id = docUri ? `${docUri}:${nodeHash}` : nodeHash;

		if (contextVal === 'ctrlztree.node.head') {
			this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiGreen'));
		} else if (contextVal === 'ctrlztree.node.branchTip') {
			this.iconPath = new vscode.ThemeIcon('git-branch');
		} else if (contextVal === 'ctrlztree.node.protected') {
			this.iconPath = new vscode.ThemeIcon('lock');
		} else if (contextVal === 'ctrlztree.node.archived') {
			this.iconPath = new vscode.ThemeIcon('archive');
		}
	}
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryTreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<HistoryTreeItem | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private tree: CtrlZTree | null = null;
	private docUri: string | null = null;

	setTree(tree: CtrlZTree, docUri: string): void {
		this.tree = tree;
		this.docUri = docUri;
		this._onDidChangeTreeData.fire();
	}

	clear(): void {
		this.tree = null;
		this.docUri = null;
		this._onDidChangeTreeData.fire();
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: HistoryTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: HistoryTreeItem): vscode.ProviderResult<HistoryTreeItem[]> {
		if (!this.tree) {
			return [];
		}

		const allNodes = this.tree.getAllNodes();
		const head = this.tree.getHead();

		if (!element) {
			// Root level: show timeline from HEAD back to initial commit
			const items: HistoryTreeItem[] = [];
			if (!head) { return items; }

			// Collect the undo chain (HEAD -> parent -> grandparent -> ... -> initial)
			const chain: string[] = [];
			const visited = new Set<string>();
			let cursor: string | null = head;
			while (cursor && !visited.has(cursor)) {
				visited.add(cursor);
				chain.push(cursor);
				const node = allNodes.get(cursor);
				cursor = node?.parent ?? null;
			}

			// Build timeline items (most recent first = HEAD)
			for (let i = 0; i < chain.length; i++) {
				const nodeHash = chain[i];
				const node = allNodes.get(nodeHash);
				if (!node) { continue; }

				const content = this.tree.getContent(nodeHash);
				const shortHash = nodeHash.substring(0, 8);
				const firstLine = content.split('\n')[0];
				const preview = firstLine.length > 45 ? firstLine.substring(0, 42) + '...' : firstLine;
				const timestamp = new Date(node.timestamp).toLocaleTimeString();

				const isHead = nodeHash === head;
				const isRoot = this.tree.getInternalRootHash() === nodeHash;
				const isInitial = this.tree.getInitialSnapshotHash() === nodeHash;
				const childCount = node.children.length;

				let label: string;
				let context: HistoryTreeItemContext;
				let collapsible: boolean;

				if (isHead) {
					label = `● HEAD — ${timestamp} — ${shortHash} — ${preview}`;
					context = 'ctrlztree.node.head';
					collapsible = childCount > 0;
				} else if (isInitial) {
					label = `◆ Initial — ${timestamp} — ${shortHash} — ${preview}`;
					context = 'ctrlztree.node.branch';
					collapsible = childCount > 0;
				} else if (isRoot) {
					label = `○ Root — ${shortHash}`;
					context = 'ctrlztree.node.branch';
					collapsible = childCount > 0;
				} else {
					const redoCount = childCount;
					const branchIndicator = redoCount > 1 ? ` [${redoCount} branches]` : '';
					label = `  ${timestamp} — ${shortHash}${branchIndicator} — ${preview}`;
					context = redoCount > 1 ? 'ctrlztree.node.branchTip' : 'ctrlztree.node.branch';
					collapsible = redoCount > 0;
				}

				const childrenHashes = collapsible ? node.children : undefined;
				items.push(new HistoryTreeItem(
					nodeHash,
					label,
					context,
					childrenHashes,
					false,
					this.docUri ?? undefined
				));
			}
			return items;
		}

		// Children: show redo children (branches off this node)
		const node = allNodes.get(element.nodeHash);
		if (!node) {
			return [];
		}

		const items: HistoryTreeItem[] = [];

		// Show parent (undo target) as first child
		if (node.parent) {
			const parentContent = this.tree.getContent(node.parent);
			const firstLine = parentContent.split('\n')[0];
			const preview = firstLine.length > 40 ? firstLine.substring(0, 37) + '...' : firstLine;
			items.push(new HistoryTreeItem(node.parent, `◀ Undo to: ${preview}`, 'ctrlztree.node.branch', undefined, false, this.docUri ?? undefined));
		}

		// Show redo children (branches)
		for (const childHash of node.children) {
			const childContent = this.tree.getContent(childHash);
			const shortHash = childHash.substring(0, 8);
			const firstLine = childContent.split('\n')[0];
			const preview = firstLine.length > 35 ? firstLine.substring(0, 32) + '...' : firstLine;
			const childNode = allNodes.get(childHash);
			const childChildren = childNode?.children ?? [];
			const isBranchTip = childChildren.length === 0;
			items.push(new HistoryTreeItem(
				childHash,
				`▶ ${shortHash}: ${preview}`,
				isBranchTip ? 'ctrlztree.node.branchTip' : 'ctrlztree.node.branch',
				undefined,
				false,
				this.docUri ?? undefined
			));
		}

		return items;
	}

	getParent?(element: HistoryTreeItem): vscode.ProviderResult<HistoryTreeItem> {
		if (!this.tree) {return null;}
		const allNodes = this.tree.getAllNodes();
		const node = allNodes.get(element.nodeHash);
		if (!node?.parent) {return null;}

		const parentNode = allNodes.get(node.parent);
		if (!parentNode) {return null;}

		const content = this.tree.getContent(node.parent);
		const firstLine = content.split('\n')[0];
		const preview = firstLine.length > 40 ? firstLine.substring(0, 37) + '...' : firstLine;
		return new HistoryTreeItem(node.parent, preview, 'ctrlztree.node.branch', undefined, false, this.docUri ?? undefined);
	}
}
