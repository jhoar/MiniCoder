export interface ConfigBackend {
  get(key: string): string | undefined;
  getRequired(key: string): string;
}

export class MissingConfigError extends Error {
  constructor(public readonly key: string) {
    super(`Required config not found: ${key}`);
    this.name = 'MissingConfigError';
  }
}

/**
 * Reads configuration from environment variables.
 * Use this for non-secret configuration (DB dialect, ports, feature flags, etc.)
 */
export class EnvConfigBackend implements ConfigBackend {
  get(key: string): string | undefined {
    return process.env[key];
  }

  getRequired(key: string): string {
    const value = process.env[key];
    if (value === undefined || value === '') {
      throw new MissingConfigError(key);
    }
    return value;
  }
}
