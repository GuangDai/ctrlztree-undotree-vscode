/**
 * Persistence lifecycle management — initialization, runtime mode switching, and auto-persist timer.
 *
 * WHAT IT DOES:
 *   - Initializes PersistenceService based on the user's persistence.mode config
 *   - Handles all 6 runtime mode transitions (off→on, off→ask, ask→on, on→off, ask→off, on→ask)
 *   - Runs a 5-second auto-persist timer that flushes dirty controllers to disk
 *
 * KEY EXPORTS:
 *   setupPersistence(context, secretStore, extensionState, log) → { persistenceService, persistenceReady }
 *   createPersistenceModeChangeHandler(extensionState, persistenceService, startTimer, log) → async (newMode) => void
 *   createPersistTimer(extensionState, log) → { start, dispose }
 *
 * ARCHITECTURAL ROLE:
 *   Thin service adapter (src/services/). Imports VS Code APIs for config reading and user prompts.
 *   Does NOT import HistoryController directly — operates through ExtensionState.historyControllers.
 */

import * as vscode from 'vscode';
import { ExtensionState } from '../state/extensionState';
import { PersistenceService } from '../security/persistenceService';
import { SecretStore } from '../security/secretStore';
import { Logger } from '../utils/logger';

export interface PersistenceLifecycleState {
    persistenceService: PersistenceService;
    persistenceReady: Promise<void>;
}

/** Initialize PersistenceService based on the current ctrlztree.persistence.mode config. */
export function setupPersistence(
    secretStore: SecretStore,
    context: vscode.ExtensionContext,
    extensionState: ExtensionState,
    log: Logger
): PersistenceLifecycleState {
    const persistenceMode = vscode.workspace.getConfiguration('ctrlztree').get<string>('persistence.mode', 'off') as 'off' | 'ask' | 'on';
    extensionState.persistenceMode = persistenceMode;
    const persistenceService = new PersistenceService(secretStore, context);
    let persistenceReady: Promise<void> = Promise.resolve();

    if (persistenceMode === 'off') {
        log.info('CtrlZTree: Persistence disabled (mode=off).');
    } else if (persistenceMode === 'on') {
        persistenceReady = persistenceService.initialize().then(initResult => {
            if (initResult.ok) {
                extensionState.persistenceActive = true;
                log.info('CtrlZTree: PersistenceService initialized (mode=on).');
            } else {
                log.warn(`CtrlZTree: PersistenceService not available: ${initResult.error}`);
            }
        });
    } else if (persistenceMode === 'ask') {
        persistenceReady = persistenceService.initialize().then(async (initResult) => {
            if (initResult.ok) {
                const choice = await vscode.window.showInformationMessage(
                    'CtrlZTree can save your edit history to disk (encrypted). Enable history persistence?',
                    'Enable', 'Not Now'
                );
                if (choice === 'Enable') {
                    extensionState.persistenceActive = true;
                    log.info('CtrlZTree: User enabled history persistence.');
                } else {
                    log.info('CtrlZTree: User declined history persistence.');
                }
            } else {
                log.warn(`CtrlZTree: PersistenceService not available: ${initResult.error}`);
            }
        });
    }

    return { persistenceService, persistenceReady };
}

export interface PersistTimerHandle {
    start(): void;
    dispose(): void;
}

/** Create auto-persist timer (5-second interval, flushes dirty controllers). */
export function createPersistTimer(extensionState: ExtensionState, log: Logger): PersistTimerHandle {
    let persistFlushInProgress = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    function start(): void {
        if (interval !== null) { return; }
        interval = setInterval(() => {
            if (!extensionState.persistenceActive || persistFlushInProgress) { return; }
            persistFlushInProgress = true;
            const flushes = Array.from(extensionState.historyControllers.entries())
                .filter(([_, c]) => c.getNeedsPersist())
                .map(([key, controller]) =>
                    controller.flushToDisk().then(result => {
                        if (!result.ok) {
                            log.error(`CtrlZTree: Persist error for ${key}: ${result.error}`);
                        }
                    }).catch(err => {
                        log.error(`CtrlZTree: Persist error for ${key}: ${err?.message || 'Unknown'}`);
                    })
                );
            Promise.allSettled(flushes).finally(() => {
                persistFlushInProgress = false;
            });
        }, 5000);
        extensionState.persistTimer = interval;
    }

    function dispose(): void {
        if (interval) {
            clearInterval(interval);
            extensionState.persistTimer = null;
            interval = null;
        }
    }

    return { start, dispose };
}

type StartTimerFn = () => void;

/**
 * Create a handler for runtime persistence.mode changes.
 * Covers all 6 transitions: off→on, off→ask, ask→on, on→off, ask→off, on→ask.
 */
export function createPersistenceModeChangeHandler(
    extensionState: ExtensionState,
    persistenceService: PersistenceService,
    maybeStartTimer: StartTimerFn,
    log: Logger
): (newMode: 'off' | 'ask' | 'on') => Promise<void> {
    return async function handlePersistenceModeChange(newMode: 'off' | 'ask' | 'on'): Promise<void> {
        const prevMode = extensionState.persistenceMode;
        if (prevMode === newMode) { return; }
        extensionState.persistenceMode = newMode;

        // ENABLE: off → on | off → ask
        if (prevMode === 'off' && (newMode === 'on' || newMode === 'ask')) {
            if (!persistenceService.isAvailable()) {
                const r = await persistenceService.initialize();
                if (!r.ok) { log.warn(`CtrlZTree: PersistenceService not available: ${r.error}`); return; }
            }
            if (newMode === 'ask') {
                const choice = await vscode.window.showInformationMessage(
                    'CtrlZTree can save your edit history to disk (encrypted). Enable history persistence?',
                    'Enable', 'Not Now'
                );
                if (choice !== 'Enable') { log.info('CtrlZTree: User declined persistence.'); return; }
            }
            extensionState.persistenceActive = true;
            for (const c of extensionState.historyControllers.values()) {
                c.setNeedsPersist(true);
            }
            maybeStartTimer();
            log.info('CtrlZTree: Persistence enabled at runtime.');
            return;
        }

        // ENABLE: ask → on (user never approved during activation)
        if (prevMode === 'ask' && newMode === 'on') {
            if (!extensionState.persistenceActive) {
                if (!persistenceService.isAvailable()) {
                    const r = await persistenceService.initialize();
                    if (!r.ok) { log.warn(`CtrlZTree: PersistenceService not available: ${r.error}`); return; }
                }
                extensionState.persistenceActive = true;
                for (const c of extensionState.historyControllers.values()) {
                    c.setNeedsPersist(true);
                }
                maybeStartTimer();
            }
            log.info('CtrlZTree: Persistence mode changed to on.');
            return;
        }

        // DISABLE: on | ask → off
        if ((prevMode === 'on' || prevMode === 'ask') && newMode === 'off') {
            for (const c of extensionState.historyControllers.values()) {
                if (c.getNeedsPersist()) {
                    try { await c.flushToDisk(); } catch { /* best-effort */ }
                }
            }
            extensionState.persistenceActive = false;
            if (extensionState.persistTimer) {
                clearInterval(extensionState.persistTimer);
                extensionState.persistTimer = null;
            }
            log.info('CtrlZTree: Persistence disabled at runtime.');
            return;
        }

        // SOFT: on → ask (keep active, just change mode for new doc restore behavior)
        if (prevMode === 'on' && newMode === 'ask') {
            log.info('CtrlZTree: Persistence mode changed to ask. Existing documents persist; new docs will prompt.');
            return;
        }
    };
}
