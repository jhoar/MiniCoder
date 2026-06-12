import * as fs from 'fs';
import * as path from 'path';

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
 * For local/single-node deployments.
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
 * Reads secrets from a JSON file on disk.
 * For local development only — clearly labelled, never used in hosted/team.
 */
export class FileSecretBackend implements SecretBackend {
  private secrets: Record<string, string> | null = null;

  constructor(private readonly filePath: string) {}

  private load(): Record<string, string> {
    if (this.secrets) return this.secrets;
    const resolved = path.resolve(this.filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`[DEV ONLY] Secrets file not found: ${resolved}`);
    }
    const raw = fs.readFileSync(resolved, 'utf-8');
    this.secrets = JSON.parse(raw) as Record<string, string>;
    return this.secrets;
  }

  async get(key: string): Promise<string> {
    const secrets = this.load();
    const value = secrets[key];
    if (value === undefined || value === '') {
      throw new MissingSecretError(key);
    }
    return value;
  }

  async list(prefix: string): Promise<string[]> {
    const secrets = this.load();
    return Object.keys(secrets).filter((k) => k.startsWith(prefix));
  }
}

/**
 * Stub for a managed cloud secret manager backend.
 * The contract exists in Phase 1; implementation is wired in hosted/team deployment config.
 */
export class ManagedSecretBackend implements SecretBackend {
  async get(_key: string): Promise<string> {
    throw new Error('ManagedSecretBackend is not implemented in this deployment profile.');
  }

  async list(_prefix: string): Promise<string[]> {
    throw new Error('ManagedSecretBackend is not implemented in this deployment profile.');
  }
}
