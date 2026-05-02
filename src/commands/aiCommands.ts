/**
 * AI-related command registrations — API key management, connection testing, and AI-powered
 * node operations (summarize, rename, propose merge).
 *
 * COMMANDS REGISTERED:
 *   ctrlztree.ai.setApiKey            — Store API key in SecretStorage
 *   ctrlztree.ai.clearApiKey          — Remove API key from SecretStorage
 *   ctrlztree.ai.testConnection       — Test AI provider connectivity
 *   ctrlztree.ai.summarizeCurrentNode — AI-summarize the current head node
 *   ctrlztree.ai.renameNode           — AI-rename a selected node (context menu)
 *   ctrlztree.ai.summarizeNode        — AI-summarize a selected node (context menu)
 *   ctrlztree.ai.proposeMerge         — AI-analyze head path for merge candidates
 *
 * KEY EXPORTS:
 *   registerAiCommands(context, deps) — registers all 7 AI commands
 *
 * ARCHITECTURAL ROLE:
 *   Command glue layer (src/commands/). Uses AiService.sendRequest() for AI calls,
 *   HistoryController.applyAiNodeUpdates() to persist results.
 */

import * as vscode from 'vscode';
import { SecretStore } from '../security/secretStore';
import { AiService } from '../ai/aiService';
import { HistoryTreeProvider } from '../ui/historyTreeProvider';
import { HistoryController } from '../history/historyController';
import { clampAiConfig } from '../config/configService';
import { Logger } from '../utils/logger';
import { ProviderName } from '../ai/providers/registry';
import { PromptContext, buildUnifiedRequest } from '../ai/promptBuilder';
import { PersistenceService } from '../security/persistenceService';
import { generateMergePlan } from '../history/mergeEngine';
import { isTrackableDocument } from '../utils/extensionUtils';

export interface AiCommandDeps {
    secretStore: SecretStore;
    aiService: AiService;
    historyTreeProvider: HistoryTreeProvider;
    getOrCreateController: (document: vscode.TextDocument) => Promise<HistoryController>;
    log: Logger;
}

export function registerAiCommands(
    context: vscode.ExtensionContext,
    deps: AiCommandDeps
): void {
    const { secretStore, aiService, historyTreeProvider, getOrCreateController, log } = deps;

    // ---- setApiKey ----
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.ai.setApiKey', async () => {
            const config = vscode.workspace.getConfiguration('ctrlztree');
            const provider = config.get<string>('ai.provider', 'openai-chat-compatible') as ProviderName;

            const validProviders: ProviderName[] = ['openai-chat-compatible', 'openai-responses', 'anthropic-messages', 'custom-http-json'];
            if (!validProviders.includes(provider)) {
                vscode.window.showErrorMessage(`CtrlZTree: Invalid provider "${provider}". Check your ai.provider setting.`);
                return;
            }

            const key = await vscode.window.showInputBox({
                prompt: `Enter API key for provider: ${provider}`,
                password: true,
                placeHolder: 'sk-... or your API key',
                ignoreFocusOut: true,
            });

            if (!key || key.trim().length === 0) {
                return;
            }

            const storageKey = `ctrlztree.ai.key.${provider}`;
            await secretStore.set(storageKey, key.trim());
            log.info(`CtrlZTree: API key saved for provider ${provider}`);
            vscode.window.showInformationMessage(`CtrlZTree: API key saved for ${provider}`);
        })
    );

    // ---- clearApiKey ----
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.ai.clearApiKey', async () => {
            const config = vscode.workspace.getConfiguration('ctrlztree');
            const provider = config.get<string>('ai.provider', 'openai-chat-compatible') as ProviderName;

            const choice = await vscode.window.showWarningMessage(
                `Clear API key for provider: ${provider}?`,
                { modal: true },
                'Clear'
            );

            if (choice !== 'Clear') {
                return;
            }

            const storageKey = `ctrlztree.ai.key.${provider}`;
            await secretStore.delete(storageKey);
            log.info(`CtrlZTree: API key cleared for provider ${provider}`);
            vscode.window.showInformationMessage(`CtrlZTree: API key cleared for ${provider}`);
        })
    );

    // ---- testConnection ----
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.ai.testConnection', async () => {
            const rawConfig = vscode.workspace.getConfiguration('ctrlztree');
            const aiConfig = clampAiConfig({
                enabled: rawConfig.get<unknown>('ai.enabled') as boolean | undefined,
                provider: rawConfig.get<string>('ai.provider'),
                model: rawConfig.get<string>('ai.model'),
                baseUrl: rawConfig.get<string>('ai.baseUrl'),
            });

            if (!aiConfig.valid) {
                vscode.window.showErrorMessage(`CtrlZTree: Invalid AI configuration: ${aiConfig.errors.join('; ')}`);
                return;
            }

            vscode.window.showInformationMessage(`CtrlZTree: Testing connection to ${aiConfig.provider} (${aiConfig.model})...`);

            const result = await aiService.testConnection(aiConfig);

            if (result.ok) {
                log.info(`CtrlZTree: Test connection to ${aiConfig.provider} successful`);
                vscode.window.showInformationMessage(`CtrlZTree: Connection to ${aiConfig.provider} (${aiConfig.model}) successful ✓`);
            } else if (result.statusCode === 401 || result.statusCode === 403) {
                log.info(`CtrlZTree: Test connection auth failed (${result.statusCode})`);
                vscode.window.showErrorMessage(`CtrlZTree: Authentication failed (${result.statusCode}). Check your API key.`);
            } else {
                log.warn(`CtrlZTree: Test connection failed: ${result.error}`);
                vscode.window.showWarningMessage(`CtrlZTree: Connection test failed: ${result.error}`);
            }
        })
    );

    // Helper: read AI config
    function getAiConfig(): ReturnType<typeof clampAiConfig> {
        const rawConfig = vscode.workspace.getConfiguration('ctrlztree');
        return clampAiConfig({
            enabled: rawConfig.get<unknown>('ai.enabled') as boolean | undefined,
            provider: rawConfig.get<string>('ai.provider'),
            model: rawConfig.get<string>('ai.model'),
            baseUrl: rawConfig.get<string>('ai.baseUrl'),
        });
    }

    // ---- summarizeCurrentNode ----
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.ai.summarizeCurrentNode', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isTrackableDocument(editor.document)) { return; }
            const aiConfig = getAiConfig();
            if (!aiConfig.valid) {
                vscode.window.showErrorMessage(`CtrlZTree: Invalid AI configuration: ${aiConfig.errors.join('; ')}`);
                return;
            }
            const controller = await getOrCreateController(editor.document);
            const proj = controller.getProjection();
            const tree = controller.getTree();
            const headHash = tree.getHead();
            if (!headHash) { return; }
            const headNodeId = controller.getNodeIdByHash(headHash);
            if (headNodeId === undefined) { return; }
            const diffStr = tree.getAllNodes().get(headHash)?.diff ?? '';
            const ctx: PromptContext = {
                task: 'summarize_node',
                nodeId: headNodeId,
                diffSummary: diffStr,
                fileLanguage: editor.document.languageId,
                filePath: editor.document.uri.fsPath,
                headNodeId,
                baseSeq: proj.lastSeq,
                docFingerprint: PersistenceService.computeFingerprint(editor.document.uri.toString()),
                projection: proj,
            };
            const request = buildUnifiedRequest(ctx, aiConfig.model);
            const response = await aiService.sendRequest(editor.document.uri.toString(), aiConfig, request);
            if ('ok' in response && response.ok === false) {
                vscode.window.showErrorMessage(`CtrlZTree: AI summarization failed: ${response.error}`);
                return;
            }
            const aiResp = response as import('../ai/types').UnifiedAiResponse;
            if (aiResp.nodeUpdates.length > 0) {
                controller.applyAiNodeUpdates(aiResp.nodeUpdates, { provider: aiConfig.provider, model: aiConfig.model });
                historyTreeProvider.refresh();
                vscode.window.showInformationMessage('CtrlZTree: AI summary applied to head node.');
            } else {
                vscode.window.showInformationMessage('CtrlZTree: AI returned no updates.');
            }
        })
    );

    // ---- renameNode (context menu) ----
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.ai.renameNode', async (item?: { nodeHash: string }) => {
            if (!item?.nodeHash) { return; }
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isTrackableDocument(editor.document)) { return; }
            const aiConfig = getAiConfig();
            if (!aiConfig.valid) {
                vscode.window.showErrorMessage(`CtrlZTree: Invalid AI configuration: ${aiConfig.errors.join('; ')}`);
                return;
            }
            const controller = await getOrCreateController(editor.document);
            const proj = controller.getProjection();
            const tree = controller.getTree();
            const nodeId = controller.getNodeIdByHash(item.nodeHash);
            if (nodeId === undefined) { return; }
            const diffStr = tree.getAllNodes().get(item.nodeHash)?.diff ?? '';
            const ctx: PromptContext = {
                task: 'rename_node',
                nodeId,
                diffSummary: diffStr,
                fileLanguage: editor.document.languageId,
                filePath: editor.document.uri.fsPath,
                headNodeId: proj.headId,
                baseSeq: proj.lastSeq,
                docFingerprint: PersistenceService.computeFingerprint(editor.document.uri.toString()),
                projection: proj,
            };
            const request = buildUnifiedRequest(ctx, aiConfig.model);
            const response = await aiService.sendRequest(editor.document.uri.toString(), aiConfig, request);
            if ('ok' in response && response.ok === false) {
                vscode.window.showErrorMessage(`CtrlZTree: AI rename failed: ${response.error}`);
                return;
            }
            const aiResp = response as import('../ai/types').UnifiedAiResponse;
            if (aiResp.nodeUpdates.length > 0) {
                controller.applyAiNodeUpdates(aiResp.nodeUpdates, { provider: aiConfig.provider, model: aiConfig.model });
                historyTreeProvider.refresh();
            }
        })
    );

    // ---- summarizeNode (context menu) ----
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.ai.summarizeNode', async (item?: { nodeHash: string }) => {
            if (!item?.nodeHash) { return; }
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isTrackableDocument(editor.document)) { return; }
            const aiConfig = getAiConfig();
            if (!aiConfig.valid) {
                vscode.window.showErrorMessage(`CtrlZTree: Invalid AI configuration: ${aiConfig.errors.join('; ')}`);
                return;
            }
            const controller = await getOrCreateController(editor.document);
            const proj = controller.getProjection();
            const tree = controller.getTree();
            const nodeId = controller.getNodeIdByHash(item.nodeHash);
            if (nodeId === undefined) { return; }
            const diffStr = tree.getAllNodes().get(item.nodeHash)?.diff ?? '';
            const ctx: PromptContext = {
                task: 'summarize_node',
                nodeId,
                diffSummary: diffStr,
                fileLanguage: editor.document.languageId,
                filePath: editor.document.uri.fsPath,
                headNodeId: proj.headId,
                baseSeq: proj.lastSeq,
                docFingerprint: PersistenceService.computeFingerprint(editor.document.uri.toString()),
                projection: proj,
            };
            const request = buildUnifiedRequest(ctx, aiConfig.model);
            const response = await aiService.sendRequest(editor.document.uri.toString(), aiConfig, request);
            if ('ok' in response && response.ok === false) {
                vscode.window.showErrorMessage(`CtrlZTree: AI summarization failed: ${response.error}`);
                return;
            }
            const aiResp = response as import('../ai/types').UnifiedAiResponse;
            if (aiResp.nodeUpdates.length > 0) {
                controller.applyAiNodeUpdates(aiResp.nodeUpdates, { provider: aiConfig.provider, model: aiConfig.model });
                historyTreeProvider.refresh();
            }
        })
    );

    // ---- proposeMerge ----
    context.subscriptions.push(
        vscode.commands.registerCommand('ctrlztree.ai.proposeMerge', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isTrackableDocument(editor.document)) { return; }
            const aiConfig = getAiConfig();
            if (!aiConfig.valid) {
                vscode.window.showErrorMessage(`CtrlZTree: Invalid AI configuration: ${aiConfig.errors.join('; ')}`);
                return;
            }
            const controller = await getOrCreateController(editor.document);
            const proj = controller.getProjection();
            const tree = controller.getTree();

            // Find linear chain on head path
            const linearChain: number[] = [];
            let cursor: number | null = proj.headId;
            while (cursor !== null && cursor !== proj.rootId) {
                const children = proj.childrenOf.get(cursor) ?? [];
                if (children.filter(c => !proj.deletedNodes.has(c) && !proj.archivedNodes.has(c)).length <= 1) {
                    linearChain.push(cursor);
                } else {
                    break;
                }
                const parent: number | null = proj.parentOf.get(cursor) ?? null;
                cursor = parent;
            }
            if (linearChain.length < 2) {
                vscode.window.showInformationMessage('CtrlZTree: No linear chain found for merge analysis.');
                return;
            }

            const siblingSummaries: string[] = [];
            for (const nodeId of linearChain) {
                const hash = controller.getHashByNodeId(nodeId);
                const diffStr = hash ? (tree.getAllNodes().get(hash)?.diff ?? '') : '';
                siblingSummaries.push(diffStr);
            }

            const parentId = proj.parentOf.get(linearChain[linearChain.length - 1]);
            let parentDiffSummary = '';
            if (parentId !== undefined && parentId !== null) {
                const parentHash = controller.getHashByNodeId(parentId);
                parentDiffSummary = parentHash ? (tree.getAllNodes().get(parentHash)?.diff ?? '') : '';
            }

            const ctx: PromptContext = {
                task: 'propose_merge',
                nodeIds: linearChain,
                diffSummary: siblingSummaries.join('\n'),
                parentDiffSummary,
                siblingSummaries,
                fileLanguage: editor.document.languageId,
                filePath: editor.document.uri.fsPath,
                headNodeId: proj.headId,
                baseSeq: proj.lastSeq,
                docFingerprint: PersistenceService.computeFingerprint(editor.document.uri.toString()),
                projection: proj,
            };
            const request = buildUnifiedRequest(ctx, aiConfig.model);
            vscode.window.showInformationMessage('CtrlZTree: Analyzing merge candidates with AI...');
            const response = await aiService.sendRequest(editor.document.uri.toString(), aiConfig, request);
            if ('ok' in response && response.ok === false) {
                vscode.window.showErrorMessage(`CtrlZTree: AI merge proposal failed: ${response.error}`);
                return;
            }
            const aiResp = response as import('../ai/types').UnifiedAiResponse;
            const mergeOps = aiResp.operationPlan.filter(p => p.operation === 'merge');
            if (mergeOps.length === 0) {
                vscode.window.showInformationMessage('CtrlZTree: AI found no merge candidates.');
            } else {
                const details = mergeOps.map(p =>
                    `Nodes ${p.targetIds.join(', ')}: ${p.reason} (risk: ${p.risk})`
                ).join('\n');
                const choice = await vscode.window.showInformationMessage(
                    `AI merge suggestions:\n${details}\n\nExecute suggested merges?`,
                    { modal: true },
                    'Execute'
                );
                if (choice === 'Execute') {
                    let merged = 0;
                    for (const plan of mergeOps) {
                        if (plan.targetIds.length < 2) { continue; }
                        const mergePlan = generateMergePlan(proj, plan.targetIds);
                        if (!mergePlan.valid) { continue; }
                        const resultContent = controller.getContent();
                        const result = controller.executeMergePlan(mergePlan, resultContent);
                        if (result.ok) { merged++; }
                    }
                    if (merged > 0) {
                        historyTreeProvider.refresh();
                        vscode.window.showInformationMessage(`CtrlZTree: Executed ${merged} AI-suggested merge(s).`);
                    }
                }
            }
        })
    );
}
