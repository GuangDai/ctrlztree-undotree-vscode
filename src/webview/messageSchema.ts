export type WebviewIncomingMessage =
	| { command: 'webviewReady' }
	| { command: 'openDiff'; shortHash: string }
	| { command: 'navigateToNode'; shortHash: string }
	| { command: 'requestTreeReload' }
	| { command: 'requestTreeReset' }
	| { command: 'webviewError'; error: { message: string; stack: string } };

const VALID_COMMANDS = new Set<string>([
	'webviewReady',
	'openDiff',
	'navigateToNode',
	'requestTreeReload',
	'requestTreeReset',
	'webviewError'
]);

function hasObjectField(obj: unknown, field: string): obj is Record<string, unknown> {
	return typeof obj === 'object' && obj !== null && typeof (obj as Record<string, unknown>)[field] === 'object' && (obj as Record<string, unknown>)[field] !== null;
}

export function isWebviewIncomingMessage(payload: unknown): payload is WebviewIncomingMessage {
	if (typeof payload !== 'object' || payload === null) {
		return false;
	}

	const msg = payload as Record<string, unknown>;
	if (typeof msg.command !== 'string' || !VALID_COMMANDS.has(msg.command)) {
		return false;
	}

	switch (msg.command) {
		case 'webviewReady':
		case 'requestTreeReload':
		case 'requestTreeReset':
			return true;
		case 'openDiff':
		case 'navigateToNode':
			return typeof msg.shortHash === 'string';
		case 'webviewError':
			if (!hasObjectField(msg, 'error')) {
				return false;
			}
			const err = msg.error as Record<string, unknown>;
			return typeof err.message === 'string' && typeof err.stack === 'string';
		default:
			return false;
	}
}
