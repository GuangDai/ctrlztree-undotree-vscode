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
	let probed = false;

	const probeAvailability = async (): Promise<boolean> => {
		if (probed) { return available; }
		try {
			await secrets.get('ctrlztree.__probe_availability__');
			probed = true;
			return available;
		} catch {
			available = false;
			probed = true;
			return false;
		}
	};

	return {
		get available() { return available; },
		async get(key: string): Promise<string | undefined> {
			if (!available) { return undefined; }
			try {
				return await secrets.get(key);
			} catch (e: any) {
				if (e?.message?.includes('not available') || e?.message?.includes('NotSupported')) {
					available = false;
				}
				throw e;
			}
		},
		async set(key: string, value: string): Promise<void> {
			if (!available) { throw new Error('SecretStorage is not available'); }
			return secrets.store(key, value);
		},
		async delete(key: string): Promise<void> {
			if (!available) { throw new Error('SecretStorage is not available'); }
			return secrets.delete(key);
		}
	};
}
