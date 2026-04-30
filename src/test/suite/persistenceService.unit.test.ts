import * as assert from 'assert';
import { PersistenceService } from '../../security/persistenceService';

suite('PersistenceService', () => {
	suite('computeFingerprint', () => {
		test('returns 24-character hex string', () => {
			const fp = PersistenceService.computeFingerprint('file:///test/file.ts');
			assert.strictEqual(typeof fp, 'string');
			assert.strictEqual(fp.length, 24);
			assert.ok(/^[a-f0-9]{24}$/.test(fp));
		});

		test('different URIs produce different fingerprints', () => {
			const fp1 = PersistenceService.computeFingerprint('file:///test/a.ts');
			const fp2 = PersistenceService.computeFingerprint('file:///test/b.ts');
			assert.notStrictEqual(fp1, fp2);
		});

		test('same URI produces same fingerprint', () => {
			const fp1 = PersistenceService.computeFingerprint('file:///test/same.ts');
			const fp2 = PersistenceService.computeFingerprint('file:///test/same.ts');
			assert.strictEqual(fp1, fp2);
		});

		test('fingerprint does not directly expose path', () => {
			const fp = PersistenceService.computeFingerprint('file:///home/user/secret_project/main.ts');
			assert.ok(!fp.includes('secret_project'));
			assert.ok(!fp.includes('home'));
			assert.ok(!fp.includes('user'));
		});
	});
});
