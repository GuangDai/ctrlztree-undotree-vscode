import * as assert from 'assert';
import { createInMemorySecretStore } from '../../security/secretStore';
import { PersistenceStore } from '../../security/persistenceStore';

suite('SecretStore', () => {
	test('in-memory store get/set/delete', async () => {
		const store = createInMemorySecretStore();
		await store.set('key1', 'value1');
		assert.strictEqual(await store.get('key1'), 'value1');
		await store.delete('key1');
		assert.strictEqual(await store.get('key1'), undefined);
	});

	test('in-memory store returns undefined for missing key', async () => {
		const store = createInMemorySecretStore();
		assert.strictEqual(await store.get('missing'), undefined);
	});

	test('in-memory store is available', () => {
		const store = createInMemorySecretStore();
		assert.strictEqual(store.available, true);
	});
});

suite('PersistenceStore Encryption', () => {
	test('initialization creates and retrieves data key', async () => {
		const secretStore = createInMemorySecretStore();
		const store = new PersistenceStore(secretStore);
		const result = await store.initialize();
		assert.strictEqual(result.ok, true);
		assert.strictEqual(store.isAvailable(), true);
	});

	test('second initialization reuses existing key', async () => {
		const secretStore = createInMemorySecretStore();
		const store = new PersistenceStore(secretStore);
		await store.initialize();

		const store2 = new PersistenceStore(secretStore);
		const result = await store2.initialize();
		assert.strictEqual(result.ok, true);
	});

	test('encrypt and decrypt round-trip', async () => {
		const secretStore = createInMemorySecretStore();
		const store = new PersistenceStore(secretStore);
		await store.initialize();

		const plaintext = 'Hello, World! This is test data for encryption.';
		const encrypted = await store.encrypt(plaintext);
		const decrypted = await store.decrypt(encrypted);

		assert.strictEqual(decrypted, plaintext);
	});

	test('encrypt and decrypt large content', async () => {
		const secretStore = createInMemorySecretStore();
		const store = new PersistenceStore(secretStore);
		await store.initialize();

		const plaintext = 'x'.repeat(10000) + '\n' + 'y'.repeat(5000);
		const encrypted = await store.encrypt(plaintext);
		const decrypted = await store.decrypt(encrypted);

		assert.strictEqual(decrypted, plaintext);
	});

	test('encrypt and decrypt with unicode', async () => {
		const secretStore = createInMemorySecretStore();
		const store = new PersistenceStore(secretStore);
		await store.initialize();

		const plaintext = '你好世界 🌍 日本語 한국어 العربية';
		const encrypted = await store.encrypt(plaintext);
		const decrypted = await store.decrypt(encrypted);

		assert.strictEqual(decrypted, plaintext);
	});

	test('encrypt and decrypt multi-line code', async () => {
		const secretStore = createInMemorySecretStore();
		const store = new PersistenceStore(secretStore);
		await store.initialize();

		const plaintext = `function hello() {
    const x = "world";
    return \`Hello \${x}\`;
}
`;
		const encrypted = await store.encrypt(plaintext);
		const decrypted = await store.decrypt(encrypted);

		assert.strictEqual(decrypted, plaintext);
	});

	test('encrypted data is not plaintext', async () => {
		const secretStore = createInMemorySecretStore();
		const store = new PersistenceStore(secretStore);
		await store.initialize();

		const plaintext = 'sensitive data here';
		const encrypted = await store.encrypt(plaintext);

		// Encrypted content should NOT contain the plaintext
		assert.strictEqual(encrypted.toString('utf8').includes(plaintext), false);
	});

	test('decryption with wrong data fails', async () => {
		const secretStore = createInMemorySecretStore();
		const store = new PersistenceStore(secretStore);
		await store.initialize();

		try {
			await store.decrypt(Buffer.from('not valid encrypted data xxxxxxxxxxxxxxxxxxxxxxxxxxx'));
			assert.fail('Should have thrown');
		} catch (e: any) {
			assert.ok(e.message);
		}
	});

	test('different plaintexts produce different ciphertexts', async () => {
		const secretStore = createInMemorySecretStore();
		const store = new PersistenceStore(secretStore);
		await store.initialize();

		const enc1 = await store.encrypt('data A');
		const enc2 = await store.encrypt('data B');
		assert.notDeepStrictEqual(enc1, enc2);
	});

	test('same plaintext produces different ciphertext (different IV)', async () => {
		const secretStore = createInMemorySecretStore();
		const store = new PersistenceStore(secretStore);
		await store.initialize();

		const enc1 = await store.encrypt('same data');
		const enc2 = await store.encrypt('same data');
		assert.notDeepStrictEqual(enc1, enc2);

		// Both should decrypt to same content
		assert.strictEqual(await store.decrypt(enc1), 'same data');
		assert.strictEqual(await store.decrypt(enc2), 'same data');
	});

	test('manifest encrypt and decrypt round-trip', async () => {
		const secretStore = createInMemorySecretStore();
		const store = new PersistenceStore(secretStore);
		await store.initialize();

		const manifest = store.buildManifest('fp-123', 42, 41);
		const encrypted = await store.encryptManifest(manifest);
		const decrypted = await store.decryptManifest(encrypted);

		assert.strictEqual(decrypted.schemaVersion, 1);
		assert.strictEqual(decrypted.docFingerprint, 'fp-123');
		assert.strictEqual(decrypted.eventCount, 42);
	});

	test('encrypted data does not leak source content', async () => {
		const secretStore = createInMemorySecretStore();
		const store = new PersistenceStore(secretStore);
		await store.initialize();

		const source = 'SECRET_API_KEY=abc123xyz';
		const encrypted = await store.encrypt(source);
		const asString = encrypted.toString('utf8');

		assert.strictEqual(asString.includes('SECRET_API_KEY'), false);
		assert.strictEqual(asString.includes('abc123xyz'), false);
	});

	test('throws when not initialized', async () => {
		const secretStore = createInMemorySecretStore();
		const store = new PersistenceStore(secretStore);

		try {
			await store.encrypt('data');
			assert.fail('Should have thrown');
		} catch (e: any) {
			assert.ok(e.message.includes('not initialized'));
		}
	});

	test('isAvailable returns false when not initialized', () => {
		const secretStore = createInMemorySecretStore();
		const store = new PersistenceStore(secretStore);
		assert.strictEqual(store.isAvailable(), false);
	});
});
