import type { ConfigBackend, SecretBackend } from '@minicoder/core';

export type TriggerBackend = 'self-host-single-node' | 'self-host-ha' | 'cloud';

export interface TriggerConfig {
  backend: TriggerBackend;
  apiUrl: string;
  apiKey: string;
  webhookSecret: string;
}

const CLOUD_API_URL = 'https://api.trigger.dev';

// Minimum entropy for HMAC webhook secrets (docs/07-security-and-secrets.md §123).
// openssl rand -hex 32 produces 64 hex chars (32 bytes of entropy).
const WEBHOOK_SECRET_MIN_LENGTH = 32;

/**
 * Load Trigger.dev configuration.
 * Non-secret config (backend type, API URL) comes from ConfigBackend.
 * Credentials (API key, webhook secret) come from SecretBackend per the
 * secrets contract in docs/07-security-and-secrets.md.
 */
export async function loadTriggerConfig(
  config: ConfigBackend,
  secrets: SecretBackend,
): Promise<TriggerConfig> {
  const raw = config.get('TRIGGERDEV_BACKEND') ?? 'self-host-single-node';
  const backend = raw as TriggerBackend;

  const apiUrl = backend === 'cloud' ? CLOUD_API_URL : config.getRequired('TRIGGERDEV_API_URL');

  const apiKey = await secrets.get('TRIGGERDEV_API_KEY');

  // Backend errors propagate: a missing or backend-error secret must not silently disable
  // webhook verification, as that would allow unauthenticated inbound payloads.
  const webhookSecret = await secrets.get('TRIGGERDEV_WEBHOOK_SECRET');
  if (webhookSecret.length < WEBHOOK_SECRET_MIN_LENGTH) {
    throw new Error(
      `TRIGGERDEV_WEBHOOK_SECRET is too short (${webhookSecret.length} chars). ` +
        `Minimum is ${WEBHOOK_SECRET_MIN_LENGTH} chars. ` +
        `Generate with: openssl rand -hex 32`,
    );
  }

  return { backend, apiUrl, apiKey, webhookSecret };
}

export function applyTriggerEnv(cfg: TriggerConfig): void {
  process.env['TRIGGER_API_URL'] = cfg.apiUrl;
  process.env['TRIGGER_SECRET_KEY'] = cfg.apiKey;
}
