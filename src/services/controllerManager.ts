/**
 * Factory functions for CtrlZTree and HistoryController lifecycle management.
 *
 * WHAT IT DOES:
 *   - Creates and caches CtrlZTree instances per document URI
 *   - Creates and caches HistoryController instances, restoring from persistence when available
 *   - Handles document-close cleanup (trees, controllers, timers, tokens)
 *   - Applies pruning when node counts exceed configured limits
 *   - Cleans up oldest histories when tracked document count exceeds limits
 *
 * KEY EXPORTS:
 *   createGetOrCreateTree(extensionState, getConfig, log) → (document) => CtrlZTree
 *   createGetOrCreateController(...) → (document) => Promise<HistoryController>
 *   createDocumentCloseHandler(extensionState, editTokens, log) → (document) => Promise<void>
 *
 * ARCHITECTURAL ROLE:
 *   Thin service adapter (src/services/). Imports VS Code APIs for workspace events.
 *   Bridges between the VS Code document model and the history core (CtrlZTree, HistoryController).
 */

import * as vscode from 'vscode';
import { CtrlZTree } from '../model/ctrlZTree';
import { ExtensionState } from '../state/extensionState';
import { HistoryController } from '../history/historyController';
import { MemoryContentStore } from '../history/contentStore';
import { DocumentTaskQueue } from '../concurrency/documentTaskQueue';
import { PersistenceService } from '../security/persistenceService';
import { ApplyEditTokenSet } from '../concurrency/applyEditTokens';
import { Logger } from '../utils/logger';
import { clampConfig, CtrlZTreeUserConfig } from '../config/configService';
import { generatePrunePlan, DEFAULT_PRUNING_POLICY } from '../history/pruningEngine';
import { maxNodeTimestamp } from '../utils/extensionUtils';

export function createGetOrCreateTree(
    extensionState: ExtensionState,
    getConfig: () => CtrlZTreeUserConfig,
    log: Logger
): (document: vscode.TextDocument) => CtrlZTree {
    return function getOrCreateTree(document: vscode.TextDocument): CtrlZTree {
        const key = document.uri.toString();
        let tree = extensionState.historyTrees.get(key);
        if (!tree) {
            tree = new CtrlZTree(document.getText());
            extensionState.historyTrees.set(key, tree);
            log.debug(`CtrlZTree: Created new tree for ${key}`);
        }

        const config = getConfig();

        if (config.enablePruning && tree.getNodeCount() > config.maxHistoryNodesPerDocument) {
            const controller = extensionState.historyControllers.get(key);
            if (controller) {
                const proj = controller.getProjection();
                const policy = { ...DEFAULT_PRUNING_POLICY, maxNodes: config.maxHistoryNodesPerDocument };
                const plan = generatePrunePlan(proj, policy);
                if (plan.archive.length > 0 || plan.delete.length > 0) {
                    log.info(`CtrlZTree: Pruning ${plan.archive.length} archive + ${plan.delete.length} delete for ${key} (${tree.getNodeCount()} nodes, max ${config.maxHistoryNodesPerDocument})`);
                    for (const nodeId of plan.archive) {
                        proj.archivedNodes.add(nodeId);
                    }
                    for (const nodeId of plan.delete) {
                        proj.deletedNodes.add(nodeId);
                    }
                    controller.setNeedsPersist(true);
                }
            } else {
                log.warn(`CtrlZTree: Pruning needed for ${key} but no controller available - nodes retained.`);
            }
        }

        if (config.enablePruning && extensionState.historyTrees.size > config.maxTrackedDocuments) {
            const entries = Array.from(extensionState.historyTrees.entries());
            const openUris = new Set(vscode.workspace.textDocuments.map(d => d.uri.toString()));
            const entriesToDelete = entries
                .filter(([uri]) => !openUris.has(uri))
                .sort((a, b) => {
                    const timeA = maxNodeTimestamp(a[1]);
                    const timeB = maxNodeTimestamp(b[1]);
                    return timeA - timeB;
                })
                .slice(0, extensionState.historyTrees.size - config.maxTrackedDocuments);

            for (const [uriToDelete] of entriesToDelete) {
                extensionState.historyTrees.delete(uriToDelete);
                log.debug(`CtrlZTree: Removed history for old document ${uriToDelete}`);
            }
        }

        return tree;
    };
}

export function createGetOrCreateController(
    extensionState: ExtensionState,
    getOrCreateTree: (document: vscode.TextDocument) => CtrlZTree,
    persistenceService: PersistenceService,
    persistenceReady: Promise<void>,
    documentQueue: DocumentTaskQueue,
    log: Logger
): (document: vscode.TextDocument) => Promise<HistoryController> {
    const pendingControllers = new Map<string, Promise<HistoryController>>();

    return async function getOrCreateController(document: vscode.TextDocument): Promise<HistoryController> {
        const key = document.uri.toString();
        let controller = extensionState.historyControllers.get(key);
        if (controller) {
            return controller;
        }
        const pending = pendingControllers.get(key);
        if (pending) {
            return pending;
        }
        const creationPromise = (async () => {
            try {
                const tree = getOrCreateTree(document);
                const contentStore = new MemoryContentStore();
                const deps = { docId: key, tree, queue: documentQueue, contentStore, persistenceService, logger: log };

                await persistenceReady;

                if (extensionState.persistenceActive) {
                    const fp = PersistenceService.computeFingerprint(key);
                    const loadResult = await persistenceService.loadDocument(fp);
                    if (loadResult.ok && loadResult.events.length > 0) {
                        let ctrl = await HistoryController.fromPersistedEvents(deps, loadResult.events, loadResult.contentEntries);
                        extensionState.historyControllers.set(key, ctrl);
                        log.info(`CtrlZTree: Restored ${loadResult.events.length} events from disk for ${key}`);
                        return ctrl;
                    }
                }

                let ctrl = new HistoryController(deps);
                extensionState.historyControllers.set(key, ctrl);
                log.debug(`CtrlZTree: Created new HistoryController for ${key}`);
                return ctrl;
            } finally {
                pendingControllers.delete(key);
            }
        })();
        pendingControllers.set(key, creationPromise);
        return creationPromise;
    };
}

export function createDocumentCloseHandler(
    extensionState: ExtensionState,
    editTokens: ApplyEditTokenSet,
    log: Logger
): (key: string) => Promise<void> {
    return async function handleDocumentClose(key: string): Promise<void> {
        const tree = extensionState.historyTrees.get(key);
        if (tree) {
            log.debug(`CtrlZTree: Cleaning up history for closed document ${key} (${tree.getNodeCount()} nodes)`);
            extensionState.historyTrees.delete(key);
        }

        const controller = extensionState.historyControllers.get(key);
        if (controller) {
            await controller.close();
            extensionState.historyControllers.delete(key);
            log.debug(`CtrlZTree: Closed HistoryController for ${key}`);
        }

        extensionState.lastChangeTime.delete(key);
        extensionState.lastCursorPosition.delete(key);
        extensionState.lastChangeType.delete(key);
        extensionState.pendingChanges.delete(key);

        const timeout = extensionState.documentChangeTimeouts.get(key);
        if (timeout) {
            clearTimeout(timeout);
            extensionState.documentChangeTimeouts.delete(key);
        }

        editTokens.clearForDoc(key);
        extensionState.rescheduleRetryCounts?.delete(key);
    };
}
