import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { SecretStore } from './secretStore';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12;  // 96 bits for GCM
const AUTH_TAG_LENGTH = 16;

export interface PersistenceManifest {
	schemaVersion: 1;
	docFingerprint: string;
	eventCount: number;
	lastEventSeq: number;
	createdAt: number;
	updatedAt: number;
}

export interface PersistResult {
	ok: true;
	bytesWritten: number;
}

export interface PersistError {
	ok: false;
	error: string;
}

export class PersistenceStore {
	private dataKey: Buffer | null = null;

	constructor(private secretStore: SecretStore) {}

	async initialize(): Promise<{ ok: true } | { ok: false; error: string }> {
		if (!this.secretStore.available) {
			return { ok: false, error: 'SecretStorage is not available' };
		}

		try {
			let keyBase64 = await this.secretStore.get('ctrlztree.persistence.dataKey');
			if (!keyBase64) {
				this.dataKey = crypto.randomBytes(KEY_LENGTH);
				await this.secretStore.set('ctrlztree.persistence.dataKey', this.dataKey.toString('base64'));
			} else {
				this.dataKey = Buffer.from(keyBase64, 'base64');
				if (this.dataKey.length !== KEY_LENGTH) {
					return { ok: false, error: 'Invalid stored data key format' };
				}
			}
			return { ok: true };
		} catch {
			return { ok: false, error: 'Failed to initialize persistence key' };
		}
	}

	isAvailable(): boolean {
		return this.dataKey !== null && this.secretStore.available;
	}

	async encrypt(plaintext: string): Promise<Buffer> {
		if (!this.dataKey) {
			throw new Error('PersistenceStore not initialized');
		}

		const iv = crypto.randomBytes(IV_LENGTH);
		const cipher = crypto.createCipheriv(ALGORITHM, this.dataKey, iv);
		const compressed = zlib.gzipSync(Buffer.from(plaintext, 'utf8'));
		const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
		const authTag = cipher.getAuthTag();

		// Format: IV (12) + AuthTag (16) + Encrypted Data
		return Buffer.concat([iv, authTag, encrypted]);
	}

	async decrypt(encrypted: Buffer): Promise<string> {
		if (!this.dataKey) {
			throw new Error('PersistenceStore not initialized');
		}

		const MAX_ENCRYPTED_SIZE = 100 * 1024 * 1024; // 100MB limit to prevent memory exhaustion
		if (encrypted.length < IV_LENGTH + AUTH_TAG_LENGTH) {
			throw new Error('Encrypted data too short');
		}
		if (encrypted.length > MAX_ENCRYPTED_SIZE) {
			throw new Error(`Encrypted data too large: ${encrypted.length} bytes (max ${MAX_ENCRYPTED_SIZE})`);
		}

		const iv = encrypted.subarray(0, IV_LENGTH);
		const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
		const data = encrypted.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

		const decipher = crypto.createDecipheriv(ALGORITHM, this.dataKey, iv);
		decipher.setAuthTag(authTag);

		const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
		const decompressed = zlib.gunzipSync(decrypted);
		return decompressed.toString('utf8');
	}

	buildManifest(docFingerprint: string, eventCount: number, lastEventSeq: number): PersistenceManifest {
		return {
			schemaVersion: 1,
			docFingerprint,
			eventCount,
			lastEventSeq,
			createdAt: Date.now(),
			updatedAt: Date.now()
		};
	}

	async encryptManifest(manifest: PersistenceManifest): Promise<Buffer> {
		return this.encrypt(JSON.stringify(manifest));
	}

	async decryptManifest(encrypted: Buffer): Promise<PersistenceManifest> {
		const json = await this.decrypt(encrypted);
		const manifest = JSON.parse(json);
		if (manifest.schemaVersion !== 1) {
			throw new Error(`Unsupported manifest schema version: ${manifest.schemaVersion}`);
		}
		return manifest;
	}
}
