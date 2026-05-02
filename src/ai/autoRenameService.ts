import { AiService } from './aiService'
import { ILogger } from '../utils/logger'
import { UnifiedAiRequest } from './types'
import { ClampedAiConfig } from '../config/configService'
import { HistoryController } from '../history/historyController'

export interface AutoRenameConfig {
	enabled: boolean
	debounceMs: number
	minDiffBytes: number
	maxDiffBytes: number
}

interface CacheEntry {
	name: string
	at: number
}

export class AutoRenameService {
	private perDocTimer = new Map<string, NodeJS.Timeout>()
	private cache = new Map<string, CacheEntry>()
	private cacheTtlMs = 300_000 // 5 min

	constructor(
		private aiService: AiService,
		private logger: ILogger,
		private config: AutoRenameConfig,
	) {}

	onDocumentCommitted(docUri: string, controller?: HistoryController): void {
		if (!this.config.enabled) { return }
		if (!controller) { return }

		const existing = this.perDocTimer.get(docUri)
		if (existing) { clearTimeout(existing) }

		const timer = setTimeout(() => {
			this.perDocTimer.delete(docUri)
			this.process(docUri, controller).catch(err => {
				this.logger.warn(`autoRename: process failed for ${docUri}: ${err?.message || 'Unknown'}`)
			})
		}, this.config.debounceMs)

		this.perDocTimer.set(docUri, timer)
	}

	cancel(docUri: string): void {
		const timer = this.perDocTimer.get(docUri)
		if (timer) {
			clearTimeout(timer)
			this.perDocTimer.delete(docUri)
		}
		this.aiService.getScheduler().cancelByDoc(docUri, 'auto-rename superseded')
	}

	private async process(docUri: string, controller: HistoryController): Promise<void> {
		const proj = controller.getProjection()
		const headId = proj.headId
		if (headId <= 0) { return }

		const headView = proj.byId.get(headId)
		if (!headView) { return }
		if (proj.deletedNodes.has(headId) || proj.archivedNodes.has(headId)) { return }
		// Don't overwrite existing names
		if (headView.name && headView.name.length > 0) { return }

		// Get diff from the legacy tree
		const tree = controller.getTree()
		const headHash = tree.getHead()
		if (!headHash) { return }

		const allNodes = tree.getAllNodes()
		const node = allNodes.get(headHash)
		const diffStr = node?.diff ?? ''
		if (!diffStr || diffStr.length === 0) { return }

		// Heuristic pre-filter
		if (diffStr.length < this.config.minDiffBytes) {
			this.logger.debug(`autoRename: skipping ${docUri} node=${headId} — diff too small (${diffStr.length}B)`)
			return
		}
		if (diffStr.length > this.config.maxDiffBytes) {
			this.logger.debug(`autoRename: skipping ${docUri} node=${headId} — diff too large (${diffStr.length}B)`)
			return
		}

		// Check whitespace-only
		const nonWhitespace = diffStr.replace(/^[+-]\s*$/gm, '').trim()
		if (nonWhitespace.length < 3) {
			this.logger.debug(`autoRename: skipping ${docUri} node=${headId} — whitespace only`)
			return
		}

		// Check cache
		const normalized = diffStr.replace(/\s+/g, ' ').trim()
		const cached = this.cache.get(normalized)
		if (cached && Date.now() - cached.at < this.cacheTtlMs) {
			this.logger.debug(`autoRename: cache hit for ${docUri} node=${headId}`)
			controller.applyAiNodeUpdates(
				[{ nodeId: headId, name: cached.name }],
				{ provider: 'cache', model: 'auto-rename' },
			)
			return
		}

		// Build request
		const config: ClampedAiConfig = {
			enabled: true,
			provider: '',
			model: '',
			baseUrl: '',
			timeoutMs: 30000,
			maxRetries: 2,
			valid: false,
			errors: [],
		}
		const filePath = (tree as any).filePath || docUri
		const language = (tree as any).language || 'plaintext'

		const request: UnifiedAiRequest = {
			task: 'annotate_node',
			model: '',
			system: '',
			messages: [{
				role: 'user',
				content: `File: ${filePath}\nLanguage: ${language}\nNodeId: ${headId}\n\nDiff:\n${diffStr}`,
			}],
			metadata: {
				promptVersion: 'auto-rename-v1',
				docFingerprint: docUri,
				headNodeId: headId,
				baseSeq: proj.lastSeq,
			},
			projection: proj,
		}

		// Send request
		this.logger.debug(`autoRename: requesting name for ${docUri} node=${headId}`)
		const result = await this.aiService.sendRequest(docUri, config, request)

		// Apply result
		if (!('ok' in result) || result.ok !== false) {
			const resp = result as any
			if (resp.nodeUpdates && resp.nodeUpdates.length > 0) {
				for (const update of resp.nodeUpdates) {
					if (update.name) {
						this.cache.set(normalized, { name: update.name, at: Date.now() })
					}
				}
				controller.applyAiNodeUpdates(resp.nodeUpdates, { provider: 'auto-rename', model: '' })
				this.logger.debug(`autoRename: applied name for ${docUri} node=${headId}`)
			}
		} else {
			this.logger.warn(`autoRename: AI request failed for ${docUri} node=${headId}: ${(result as any).error}`)
		}
	}
}
