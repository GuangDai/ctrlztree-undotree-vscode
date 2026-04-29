import * as assert from 'assert';
import { redactSensitiveData, redactRequestData } from '../../ai/redactor';

suite('Redactor', () => {
	suite('Authorization Header', () => {
		test('redacts Bearer token', () => {
			const result = redactSensitiveData('Authorization: Bearer anyformat-key-12345');
			assert.ok(result.redacted.includes('[REDACTED]'));
			assert.ok(!result.redacted.includes('anyformat-key-12345'));
		});

		test('redacts Bearer token regardless of key format', () => {
			const result = redactSensitiveData('Authorization: Bearer sk-Z9b8a7c6d5e4f3g2h1i0j9k8l7m6n5o4p3q2r1s0');
			assert.ok(!result.redacted.includes('sk-Z9b8a7c6'));
		});
	});

	suite('URL Query Secrets', () => {
		test('redacts api_key in query string', () => {
			const result = redactSensitiveData('https://api.example.com?api_key=whatever_the_key_is');
			assert.ok(!result.redacted.includes('whatever_the_key_is'));
		});

		test('redacts token in query string', () => {
			const result = redactSensitiveData('https://host.com?token=abc123&user=me');
			assert.ok(!result.redacted.includes('abc123'));
		});

		test('redacts client_secret in query string', () => {
			const result = redactSensitiveData('https://auth.com/oauth?client_secret=mysecret&grant_type=code');
			assert.ok(!result.redacted.includes('mysecret'));
		});
	});

	suite('Passwords', () => {
		test('redacts password: assignment', () => {
			const result = redactSensitiveData('password: hunter2');
			assert.ok(!result.redacted.includes('hunter2'));
			assert.ok(result.redacted.includes('password: [REDACTED]'));
		});

		test('redacts password= assignment', () => {
			const result = redactSensitiveData('password=supersecret');
			assert.ok(!result.redacted.includes('supersecret'));
		});

		test('redacts DB_PASSWORD env var', () => {
			const result = redactSensitiveData('DB_PASSWORD=my_db_pass');
			assert.ok(!result.redacted.includes('my_db_pass'));
		});
	});

	suite('Environment Variables', () => {
		test('redacts AWS_SECRET', () => {
			const result = redactSensitiveData('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
			assert.ok(!result.redacted.includes('wJalrXUtn'));
		});

		test('redacts GCP_KEY', () => {
			const result = redactSensitiveData('GCP_KEY=mygcpkey123');
			assert.ok(!result.redacted.includes('mygcpkey123'));
		});
	});

	suite('PEM Private Key', () => {
		test('redacts PEM private key block', () => {
			const pem = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...
-----END PRIVATE KEY-----`;
			const result = redactSensitiveData(pem);
			assert.ok(result.redacted.includes('[REDACTED]'));
			assert.ok(!result.redacted.includes('MIIEvQIBADAN'));
		});
	});

	suite('Non-sensitive data', () => {
		test('does not redact normal text', () => {
			const result = redactSensitiveData('hello world this is normal code');
			assert.strictEqual(result.changes, 0);
		});

		test('does not redact function source code', () => {
			const code = 'function authenticate(user) { return user.isValid(); }';
			const result = redactSensitiveData(code);
			assert.strictEqual(result.changes, 0);
		});

		test('does not redact benign URLs', () => {
			const url = 'https://api.example.com/v1/users?id=42';
			const result = redactSensitiveData(url);
			// No secret params
			assert.strictEqual(result.changes, 0);
		});
	});

	suite('redactRequestData', () => {
		test('redacts nested request body', () => {
			const body = {
				model: 'gpt-4',
				messages: [
					{ role: 'user', content: 'hello' },
					{ role: 'assistant', content: 'Authorization: Bearer pk-abcdefghijklmnopqrstuvwxyz1234567890' }
				],
				settings: {
					env: 'DB_PASSWORD=secret123'
				}
			};

			const redacted = redactRequestData(body);
			const assistantContent = (redacted.messages as any[])[1].content;
			assert.ok(!assistantContent.includes('pk-abcdefghij'));
			const envVal = (redacted.settings as any).env;
			assert.ok(!envVal.includes('secret123'));
		});

		test('preserves non-string values', () => {
			const body = { temperature: 0.7, max_tokens: 100, enabled: true, count: 42 };
			const redacted = redactRequestData(body);
			assert.strictEqual(redacted.temperature, 0.7);
			assert.strictEqual(redacted.max_tokens, 100);
		});
	});
});
