import * as vscode from 'vscode';
import { CtrlZTree } from '../model/ctrlZTree';
import { ApplyEditTokenSet } from '../concurrency/applyEditTokens';
import { HistoryController } from '../history/historyController';

export type ChangeType = 'typing' | 'deletion' | 'other';

export interface ExtensionState {
    documentChangeTimeouts: Map<string, NodeJS.Timeout>;
    pendingChanges: Map<string, string>;
    lastChangeTime: Map<string, number>;
    lastCursorPosition: Map<string, vscode.Position>;
    lastChangeType: Map<string, ChangeType>;
    historyTrees: Map<string, CtrlZTree>;
    historyControllers: Map<string, HistoryController>;
    processingDocuments: Set<string>;
    rescheduleRetryCounts: Map<string, number>;
    lastValidEditorUri: string | null;
    lastOpenedDiffEditor: vscode.TextEditor | null;
    editTokens: ApplyEditTokenSet | null;
    persistTimer: NodeJS.Timeout | null;
    persistenceActive: boolean;
    persistenceMode: 'off' | 'ask' | 'on';
}

export function createExtensionState(): ExtensionState {
    return {
        documentChangeTimeouts: new Map<string, NodeJS.Timeout>(),
        pendingChanges: new Map<string, string>(),
        lastChangeTime: new Map<string, number>(),
        lastCursorPosition: new Map<string, vscode.Position>(),
        lastChangeType: new Map<string, ChangeType>(),
        historyTrees: new Map<string, CtrlZTree>(),
        historyControllers: new Map<string, HistoryController>(),
        processingDocuments: new Set<string>(),
        rescheduleRetryCounts: new Map<string, number>(),
        lastValidEditorUri: null,
        lastOpenedDiffEditor: null,
        editTokens: null,
        persistTimer: null,
        persistenceActive: false,
        persistenceMode: 'off',
    };
}
