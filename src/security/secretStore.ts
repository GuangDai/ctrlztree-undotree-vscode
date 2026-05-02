export interface SecretStore {
	get(key: string): Promise<string | undefined>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
	readonly available: boolean;
}

export function createInMemorySecretStore(): SecretStore {
	const storage = new Map<string, string>();
	return {
		available: true,
		async get(key: string): Promise<string | undefined> {
			return storage.get(key);
		},
		async set(key: string, value: string): Promise<void> {
			storage.set(key, value);
		},
		async delete(key: string): Promise<void> {
			storage.delete(key);
		}
	};
}

export function createVSCodeSecretStore(secrets: { get(key: string): Thenable<string | undefined>; store(key: string, value: string): Thenable<void>; delete(key: string): Thenable<void> }): SecretStore {
	let available = true;
	let permanentlyUnavailable = false;
	let lastErrorTime = 0;

	// Probe proactively on construction (fire-and-forget)
	Promise.resolve(secrets.get('ctrlztree.__probe_availability__'))
		.then(() => { available = true; permanentlyUnavailable = false; })
		.catch(() => { available = false; permanentlyUnavailable = false; });

	function handleError(e: any): void {
		if (e?.message?.includes('NotSupported')) {
			// Platform doesn't support secret storage — permanent
			available = false;
			permanentlyUnavailable = true;
		} else if (e?.message?.includes('not available') || e?.message?.includes('timed out') ||
			e?.message?.includes('ECONNREFUSED') || e?.message?.includes('temporarily')) {
			// Transient unavailability — allow retry after cooldown
			available = false;
			lastErrorTime = Date.now();
		}
	}

	function maybeRecover(): void {
		if (!available && !permanentlyUnavailable && Date.now() - lastErrorTime > 30000) {
			// attempt recovery after 30s cooldown
			available = true;
		}
	}

	return {
		get available() { maybeRecover(); return available; },
		async get(key: string): Promise<string | undefined> {
			maybeRecover();
			if (!available) { return undefined; }
			try {
				return await secrets.get(key);
			} catch (e: any) {
				handleError(e);
				throw e;
			}
		},
		async set(key: string, value: string): Promise<void> {
			maybeRecover();
			if (!available) { throw new Error('SecretStorage is not available'); }
			try {
				return await secrets.store(key, value);
			} catch (e: any) {
				handleError(e);
				throw e;
			}
		},
		async delete(key: string): Promise<void> {
			maybeRecover();
			if (!available) { throw new Error('SecretStorage is not available'); }
			try {
				return await secrets.delete(key);
			} catch (e: any) {
				handleError(e);
				throw e;
			}
		}
	};
}
