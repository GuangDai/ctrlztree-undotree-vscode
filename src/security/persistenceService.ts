import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { PersistenceStore } from './persistenceStore';
import { SecretStore } from './secretStore';
import { HistoryEvent } from '../history/events';
import { EventSeq } from '../history/ids';

interface DocManifest {
	schemaVersion: 1;
	docFingerprint: string;
	eventCount: number;
	lastEventSeq: number;
	createdAt: number;
	updatedAt: number;
	dataHash?: string;
}

export class PersistenceService {
	private persistenceStore: PersistenceStore;
	private basePath: vscode.Uri;

	constructor(
		private secretStore: SecretStore,
		private context: vscode.ExtensionContext,
	) {
		this.persistenceStore = new PersistenceStore(secretStore);
		this.basePath = vscode.Uri.joinPath(context.globalStorageUri, 'ctrlztree-v2', 'docs');
	}

	async initialize(): Promise<{ ok: true } | { ok: false; error: string }> {
		return this.persistenceStore.initialize();
	}

	isAvailable(): boolean {
		return this.persistenceStore.isAvailable();
	}

	async saveDocument(
		docFingerprint: string,
		events: readonly HistoryEvent[],
		lastSeq: EventSeq,
		contentEntries?: Array<{ nodeId: number; content: string }>,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		if (!this.isAvailable()) {
			return { ok: false, error: 'PersistenceStore is not available' };
		}

		try {
			const ndjson = events.map(e => JSON.stringify(e)).join('\n') + '\n';
			const dataHash = crypto.createHash('sha256').update(ndjson, 'utf8').digest('hex');

			const encryptedData = await this.persistenceStore.encrypt(ndjson);

			// Try loading existing manifest to preserve createdAt
			let createdAt = Date.now();
			try {
				const existingManifestFile = vscode.Uri.joinPath(vscode.Uri.joinPath(this.basePath, docFingerprint), 'manifest.json.enc');
				const existingEncrypted = await vscode.workspace.fs.readFile(existingManifestFile);
				const existingJson = await this.persistenceStore.decrypt(Buffer.from(existingEncrypted));
				const existing = JSON.parse(existingJson);
				if (typeof existing.createdAt === 'number') {
					createdAt = existing.createdAt;
				}
			} catch {
				// No existing manifest, use current time
			}

			const manifest: DocManifest = {
				schemaVersion: 1,
				docFingerprint,
				eventCount: events.length,
				lastEventSeq: lastSeq,
				createdAt,
				updatedAt: Date.now(),
				dataHash,
			};
			const encryptedManifest = await this.persistenceStore.encrypt(JSON.stringify(manifest));

			const docDir = vscode.Uri.joinPath(this.basePath, docFingerprint);
			await vscode.workspace.fs.createDirectory(docDir);

			const dataFile = vscode.Uri.joinPath(docDir, 'events.ndjson.enc');
			const manifestFile = vscode.Uri.joinPath(docDir, 'manifest.json.enc');
			const contentFile = vscode.Uri.joinPath(docDir, 'content.ndjson.enc');

			// Write manifest first, then data, then content
			await vscode.workspace.fs.writeFile(manifestFile, encryptedManifest);
			await vscode.workspace.fs.writeFile(dataFile, encryptedData);
			if (contentEntries && contentEntries.length > 0) {
				const contentNdjson = contentEntries.map(c => JSON.stringify(c)).join('\n') + '\n';
				const encryptedContent = await this.persistenceStore.encrypt(contentNdjson);
				await vscode.workspace.fs.writeFile(contentFile, encryptedContent);
			}

			return { ok: true };
		} catch (e: any) {
			return { ok: false, error: `Failed to save document: ${e?.message || 'Unknown error'}` };
		}
	}

	async loadDocument(
		docFingerprint: string,
	): Promise<{ ok: true; events: HistoryEvent[]; lastSeq: EventSeq; contentEntries?: Array<{ nodeId: number; content: string }> } | { ok: false; error: string }> {
		if (!this.isAvailable()) {
			return { ok: false, error: 'PersistenceStore is not available' };
		}

		try {
			const docDir = vscode.Uri.joinPath(this.basePath, docFingerprint);
			const manifestFile = vscode.Uri.joinPath(docDir, 'manifest.json.enc');
			const dataFile = vscode.Uri.joinPath(docDir, 'events.ndjson.enc');

			const encryptedManifest = await vscode.workspace.fs.readFile(manifestFile);
			const manifestJson = await this.persistenceStore.decrypt(Buffer.from(encryptedManifest));
			const manifest: DocManifest = JSON.parse(manifestJson);

			if (manifest.schemaVersion !== 1) {
				return { ok: false, error: `Unsupported manifest schema version: ${manifest.schemaVersion}` };
			}

			const encryptedData = await vscode.workspace.fs.readFile(dataFile);
			const ndjson = await this.persistenceStore.decrypt(Buffer.from(encryptedData));

			const events: HistoryEvent[] = [];
			const lines = ndjson.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const trimmed = lines[i].trim();
				if (trimmed.length === 0) { continue; }
				try {
					events.push(JSON.parse(trimmed));
				} catch {
					return { ok: false, error: `Malformed event on line ${i + 1}: data may be corrupt` };
				}
			}

			if (events.length !== manifest.eventCount) {
				return { ok: false, error: `Event count mismatch: expected ${manifest.eventCount}, got ${events.length}` };
			}

			// Verify data integrity hash if present
			if (manifest.dataHash) {
				const loadedDataHash = crypto.createHash('sha256').update(ndjson, 'utf8').digest('hex');
				if (loadedDataHash !== manifest.dataHash) {
					return { ok: false, error: 'Data integrity check failed: events file may be corrupt' };
				}
			}

			// Load ContentStore entries if present
			let contentEntries: Array<{ nodeId: number; content: string }> | undefined;
			const contentFile = vscode.Uri.joinPath(docDir, 'content.ndjson.enc');
			try {
				const encryptedContent = await vscode.workspace.fs.readFile(contentFile);
				const contentNdjson = await this.persistenceStore.decrypt(Buffer.from(encryptedContent));
				contentEntries = [];
				const clines = contentNdjson.split('\n');
				for (let i = 0; i < clines.length; i++) {
					const trimmed = clines[i].trim();
					if (trimmed.length === 0) { continue; }
					try {
						contentEntries.push(JSON.parse(trimmed));
					} catch {
						return { ok: false, error: `Malformed content entry on line ${i + 1}` };
					}
				}
			} catch {
				// Content file is optional — events can exist without persisted content
			}

			return { ok: true, events, lastSeq: manifest.lastEventSeq, contentEntries };
		} catch (e: any) {
			if (e?.code === 'FileNotFound' || e?.message?.includes('not found')) {
				return { ok: false, error: 'No saved data for this document' };
			}
			return { ok: false, error: `Failed to load document: ${e?.message || 'Unknown error'}` };
		}
	}

	async deleteDocument(docFingerprint: string): Promise<{ ok: true } | { ok: false; error: string }> {
		try {
			const docDir = vscode.Uri.joinPath(this.basePath, docFingerprint);
			const dataFile = vscode.Uri.joinPath(docDir, 'events.ndjson.enc');
			const manifestFile = vscode.Uri.joinPath(docDir, 'manifest.json.enc');
			const contentFile = vscode.Uri.joinPath(docDir, 'content.ndjson.enc');

			try { await vscode.workspace.fs.delete(dataFile); } catch { /* ignore */ }
			try { await vscode.workspace.fs.delete(manifestFile); } catch { /* ignore */ }
			try { await vscode.workspace.fs.delete(contentFile); } catch { /* ignore */ }
			try { await vscode.workspace.fs.delete(docDir); } catch { /* ignore */ }

			return { ok: true };
		} catch {
			return { ok: false, error: 'Failed to delete persisted document' };
		}
	}

	async listDocuments(): Promise<string[]> {
		try {
			const entries = await vscode.workspace.fs.readDirectory(this.basePath);
			return entries
				.filter(([name]) => !name.startsWith('.'))
				.map(([name]) => name);
		} catch {
			return [];
		}
	}

	static computeFingerprint(docUri: string): string {
		return crypto.createHash('sha256').update(docUri, 'utf8').digest('hex').slice(0, 24);
	}
}
