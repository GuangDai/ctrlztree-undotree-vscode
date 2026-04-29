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
	{ name: 'pem_private_key', pattern: /-----BEGIN[^-]*PRIVATE KEY-----[^-]*-----END[^-]*PRIVATE KEY-----/gs, replacement: '-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----' },

	// API key header (X-Api-Key, X-API-Key, api-key, apikey)
	{ name: 'api_key_header', pattern: /(?:X-Api-Key|X-API-Key|api-key|apikey):\s*[^\n\r]*/gi, replacement: 'X-Api-Key: [REDACTED]' },
];

const SENSITIVE_KEYS = new Set([
	'apikey', 'api_key', 'api-key', 'apikey', 'apiKey',
	'secret', 'client_secret', 'clientSecret',
	'password', 'passwd', 'pwd',
	'token', 'access_token', 'accessToken', 'refresh_token', 'refreshToken',
	'authorization', 'auth',
	'private_key', 'privateKey', 'secret_key', 'secretKey',
	'credential', 'credentials',
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
	const redacted: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(body)) {
		const isSensitiveKey = SENSITIVE_KEYS.has(key.toLowerCase());

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
					return redactRequestData(item as Record<string, unknown>);
				}
				return item;
			});
		} else if (typeof value === 'object' && value !== null) {
			redacted[key] = redactRequestData(value as Record<string, unknown>);
		} else {
			redacted[key] = value;
		}
	}

	return redacted;
}
