export interface SecretBackend {
  get(key: string): Promise<string>;
  list(prefix: string): Promise<string[]>;
}

export class MissingSecretError extends Error {
  constructor(public readonly key: string) {
    super(`Secret not found: ${key}`);
    this.name = 'MissingSecretError';
  }
}

/**
 * Reads secrets from environment variables.
 * Suitable for local/single-node and CI; populate via OS keychain, dotenv loader,
 * or secrets injection (e.g. Docker secrets mounted as env vars) — never commit
 * plaintext secret values.
 */
export class EnvSecretBackend implements SecretBackend {
  async get(key: string): Promise<string> {
    const value = process.env[key];
    if (value === undefined || value === '') {
      throw new MissingSecretError(key);
    }
    return value;
  }

  async list(prefix: string): Promise<string[]> {
    return Object.keys(process.env).filter((k) => k.startsWith(prefix));
  }
}

/**
 * Stub for a managed cloud secret manager backend.
 * The contract exists in Phase 1; the concrete implementation is wired in
 * hosted/team deployment configuration (Phase 2+).
 */
export class ManagedSecretBackend implements SecretBackend {
  async get(_key: string): Promise<string> {
    throw new Error('ManagedSecretBackend is not implemented in this deployment profile.');
  }

  async list(_prefix: string): Promise<string[]> {
    throw new Error('ManagedSecretBackend is not implemented in this deployment profile.');
  }
}
