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
			// Root level: show current head
			const items: HistoryTreeItem[] = [];
			if (head) {
				const headContent = this.tree.getContent(head);
				const firstLine = headContent.split('\n')[0];
				const preview = firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
				items.push(new HistoryTreeItem(head, `HEAD: ${preview}`, 'ctrlztree.node.head', undefined, true, this.docUri ?? undefined));
			}
			return items;
		}

		// Children: show branch tips and redo children
		const node = allNodes.get(element.nodeHash);
		if (!node) {
			return [];
		}

		const items: HistoryTreeItem[] = [];

		// Show parent (undo target)
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
				`${shortHash}: ${preview}`,
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
