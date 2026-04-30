const REDACTION_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
	// Authorization header: Bearer <anything>
	{ name: 'authorization_bearer', pattern: /Authorization:\s*Bearer\s+[^\n\r]*/gi, replacement: 'Authorization: Bearer [REDACTED]' },

	// URL query parameters commonly used for auth
	{ name: 'url_secret_param', pattern: /([?&](?:api_key|apikey|api-key|token|access_token|secret|key|client_secret))=[^&\s]+/gi, replacement: '$1=[REDACTED]' },

	// Assignment-style secrets: KEY = <value> or KEY: <value>
	{ name: 'secret_assignment', pattern: /(password|passwd|pwd|secret|secret_key|secretKey|private_key|privateKey|signing_key|api_key|apikey|apiKey)\s*[:=]\s*[^\n\r]*/gi, replacement: '$1: [REDACTED]' },

	// Environment variable credentials (cloud-agnostic, matches common env var names)
	{ name: 'env_secret', pattern: /(DB_PASSWORD|DATABASE_PASSWORD|REDIS_PASSWORD|MONGO_URI|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|GOOGLE_APPLICATION_CREDENTIALS|GCP_KEY|AZURE_STORAGE_KEY|AZURE_CLIENT_SECRET|CLOUDFLARE_API_KEY|DOCKER_PASSWORD)\s*=\s*[^\n\r]*/gi, replacement: '$1=[REDACTED]' },

	// PEM private key block
	{ name: 'pem_private_key', pattern: /-----BEGIN .*?PRIVATE KEY-----[\s\S]*?-----END .*?PRIVATE KEY-----/g, replacement: '-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----' },

	// API key header (X-Api-Key, X-API-Key, api-key, apikey)
	{ name: 'api_key_header', pattern: /(?:X-Api-Key|X-API-Key|api-key|apikey):\s*[^\n\r]*/gi, replacement: 'X-Api-Key: [REDACTED]' },
];

const SENSITIVE_KEYS = new Set([
	'apikey', 'api_key', 'api-key',
	'secret', 'client_secret', 'clientsecret',
	'password', 'passwd', 'pwd',
	'token', 'access_token', 'accesstoken', 'refresh_token', 'refreshtoken',
	'authorization', 'auth',
	'private_key', 'privatekey', 'secret_key', 'secretkey',
	'credential', 'credentials',
	'cookie', 'set-cookie', 'set_cookie', 'setcookie',
	'proxy-authorization', 'proxy_authorization', 'proxyauthorization',
]);

const SENSITIVE_HEADERS_LOWER = new Set([
	'authorization', 'proxy-authorization', 'proxy_authorization',
	'cookie', 'set-cookie',
	'x-api-key', 'x-api-key', 'apikey', 'api-key',
]);

export interface RedactionResult {
	redacted: string;
	changes: number;
	detectedPatterns: string[];
}

export function redactSensitiveData(text: string): RedactionResult {
	let result = text;
	let changes = 0;
	const detectedPatterns: string[] = [];

	for (const { name, pattern, replacement } of REDACTION_PATTERNS) {
		const before = result;
		result = result.replace(pattern, replacement);
		if (result !== before) {
			changes++;
			detectedPatterns.push(name);
		}
	}

	return { redacted: result, changes, detectedPatterns };
}

export function redactRequestData(body: Record<string, unknown>): Record<string, unknown> {
	const seen = new WeakSet<object>();
	return redactRequestDataInternal(body, seen);
}

function redactRequestDataInternal(body: Record<string, unknown>, seen: WeakSet<object>): Record<string, unknown> {
	if (seen.has(body)) {
		return { '[CYCLIC]': '[CYCLIC]' };
	}
	seen.add(body);

	const redacted: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(body)) {
		const keyLower = key.toLowerCase();
		const isSensitiveKey = SENSITIVE_KEYS.has(keyLower) || SENSITIVE_HEADERS_LOWER.has(keyLower);

		if (typeof value === 'string') {
			if (isSensitiveKey) {
				redacted[key] = '[REDACTED]';
			} else {
				const r = redactSensitiveData(value);
				redacted[key] = r.redacted;
			}
		} else if (Array.isArray(value)) {
			redacted[key] = value.map(item => {
				if (typeof item === 'string') {
					return redactSensitiveData(item).redacted;
				}
				if (typeof item === 'object' && item !== null) {
					return redactRequestDataInternal(item as Record<string, unknown>, seen);
				}
				return item;
			});
		} else if (typeof value === 'object' && value !== null) {
			redacted[key] = redactRequestDataInternal(value as Record<string, unknown>, seen);
		} else {
			redacted[key] = value;
		}
	}

	return redacted;
}
