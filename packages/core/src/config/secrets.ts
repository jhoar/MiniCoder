export interface SecretBackend {
  get(key: string): Promise<string>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
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
 *
 * `set`/`delete` mutate `process.env` for the current process only — there is no
 * persistence across restarts. This is the same non-durability every env-var-backed
 * config already has; callers needing durable secret writes should use
 * `ManagedSecretBackend` instead.
 */
export class EnvSecretBackend implements SecretBackend {
  async get(key: string): Promise<string> {
    const value = process.env[key];
    if (value === undefined || value === '') {
      throw new MissingSecretError(key);
    }
    return value;
  }

  async set(key: string, value: string): Promise<void> {
    process.env[key] = value;
  }

  async delete(key: string): Promise<void> {
    delete process.env[key];
  }

  async list(prefix: string): Promise<string[]> {
    return Object.keys(process.env).filter((k) => k.startsWith(prefix));
  }
}

export interface ManagedSecretBackendConfig {
  /** Base URL of a secrets-manager-compatible REST facade (e.g. a thin proxy in front of a cloud
   * KMS/secret manager). Trailing slashes are stripped. */
  baseUrl?: string;
  /** Bearer credential presented to the facade. */
  apiKey?: string;
  /** Injectable fetch implementation, primarily for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Cloud KMS/secret-manager backend for hosted/team deployments.
 *
 * Deliberately does **not** read or write MiniCoder's own database — docs/07-security-and-
 * secrets.md §2 is explicit that "no plaintext at rest in MiniCoder state" and "any encryption
 * keys live in the secret backend, not the application database." Backing this by a `secrets`
 * table in the app DB (an approach considered and rejected — see the class-level comment on
 * `EnvSecretBackend`'s sibling rejection of a plaintext `FileSecretBackend` for the same class of
 * reason) would violate that invariant. Instead this is a plain HTTP client against a
 * secrets-manager-compatible REST facade — the same "provider-neutral, plain `fetch`-based seam"
 * pattern already used for `HttpCodeGenerationProvider`/`HttpReviewProvider` — so it can front any
 * concrete KMS/secret manager (HashiCorp Vault's KV v2 REST API, a small AWS Secrets Manager/Azure
 * Key Vault proxy, or an internal secrets service) without importing a provider SDK into
 * `packages/core` (the "Orchestrator Core is provider-SDK-free" locked decision).
 *
 * Contract expected of the facade:
 *   GET    {baseUrl}/secrets/{key}          -> 200 {"value": string} | 404
 *   PUT    {baseUrl}/secrets/{key}          <- {"value": string}     -> 2xx
 *   DELETE {baseUrl}/secrets/{key}          -> 2xx | 404 (treated as already-deleted)
 *   GET    {baseUrl}/secrets?prefix={p}     -> 200 {"keys": string[]}
 * Every request carries `Authorization: Bearer {apiKey}`. Encryption at rest and in transit (TLS)
 * is the facade's responsibility, per docs/07 §2.
 */
export class ManagedSecretBackend implements SecretBackend {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ManagedSecretBackendConfig = {}) {
    const baseUrl = config.baseUrl ?? process.env['MANAGED_SECRETS_URL'];
    const apiKey = config.apiKey ?? process.env['MANAGED_SECRETS_API_KEY'];
    if (!baseUrl || !apiKey) {
      throw new Error(
        'ManagedSecretBackend requires MANAGED_SECRETS_URL and MANAGED_SECRETS_API_KEY ' +
          '(or an explicit { baseUrl, apiKey } config) — no default cloud KMS/secret-manager ' +
          'client is bundled; point this at a secrets-manager-compatible REST facade.',
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async get(key: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/secrets/${encodeURIComponent(key)}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (res.status === 404) throw new MissingSecretError(key);
    if (!res.ok) {
      throw new Error(`ManagedSecretBackend.get(${key}) failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { value?: unknown };
    if (typeof body.value !== 'string') throw new MissingSecretError(key);
    return body.value;
  }

  async set(key: string, value: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/secrets/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ value }),
    });
    if (!res.ok) {
      throw new Error(`ManagedSecretBackend.set(${key}) failed: HTTP ${res.status}`);
    }
  }

  async delete(key: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/secrets/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`ManagedSecretBackend.delete(${key}) failed: HTTP ${res.status}`);
    }
  }

  async list(prefix: string): Promise<string[]> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/secrets?prefix=${encodeURIComponent(prefix)}`,
      { method: 'GET', headers: this.headers() },
    );
    if (!res.ok) {
      throw new Error(`ManagedSecretBackend.list(${prefix}) failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { keys?: unknown };
    return Array.isArray(body.keys)
      ? body.keys.filter((k): k is string => typeof k === 'string')
      : [];
  }
}
