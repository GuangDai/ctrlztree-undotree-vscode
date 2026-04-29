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
	return {
		available: true,
		async get(key: string): Promise<string | undefined> {
			return secrets.get(key);
		},
		async set(key: string, value: string): Promise<void> {
			return secrets.store(key, value);
		},
		async delete(key: string): Promise<void> {
			return secrets.delete(key);
		}
	};
}
