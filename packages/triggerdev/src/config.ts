import type { ConfigBackend, SecretBackend } from '@minicoder/core';

export type TriggerBackend = 'self-host-single-node' | 'self-host-ha' | 'cloud';

export interface TriggerConfig {
  backend: TriggerBackend;
  apiUrl: string;
  apiKey: string;
  webhookSecret: string;
}

const CLOUD_API_URL = 'https://api.trigger.dev';

const VALID_BACKENDS: readonly TriggerBackend[] = [
  'self-host-single-node',
  'self-host-ha',
  'cloud',
];

// 32 bytes of cryptographic randomness encoded as hex = 64 hex characters.
// Generate with: openssl rand -hex 32 (docs/07-security-and-secrets.md §123).
const WEBHOOK_SECRET_MIN_LENGTH = 64;

/**
 * Load Trigger.dev configuration.
 * Non-secret config (backend type, API URL) comes from ConfigBackend.
 * Credentials (API key, webhook secret) come from SecretBackend per the
 * secrets contract in docs/07-security-and-secrets.md.
 *
 * Call sites: wired in Phases 6–8 as Orchestrator Core commands are added.
 */
export async function loadTriggerConfig(
  config: ConfigBackend,
  secrets: SecretBackend,
): Promise<TriggerConfig> {
  const raw = config.get('TRIGGERDEV_BACKEND') ?? 'self-host-single-node';
  if (!VALID_BACKENDS.includes(raw as TriggerBackend)) {
    throw new Error(
      `Invalid TRIGGERDEV_BACKEND value: '${raw}'. Must be one of: ${VALID_BACKENDS.join(', ')}`,
    );
  }
  const backend = raw as TriggerBackend;

  const apiUrl = backend === 'cloud' ? CLOUD_API_URL : config.getRequired('TRIGGERDEV_API_URL');

  const apiKey = await secrets.get('TRIGGERDEV_API_KEY');

  // Backend errors propagate: a missing or backend-error secret must not silently disable
  // webhook verification, as that would allow unauthenticated inbound payloads.
  // Signature verification is wired in Phase 7 (GitHub webhook integration).
  const webhookSecret = await secrets.get('TRIGGERDEV_WEBHOOK_SECRET');
  if (webhookSecret.length < WEBHOOK_SECRET_MIN_LENGTH) {
    throw new Error(
      `TRIGGERDEV_WEBHOOK_SECRET is too short (${webhookSecret.length} chars). ` +
        `Minimum is ${WEBHOOK_SECRET_MIN_LENGTH} chars (32 bytes hex). ` +
        `Generate with: openssl rand -hex 32`,
    );
  }

  return { backend, apiUrl, apiKey, webhookSecret };
}

/**
 * Apply TriggerConfig to process.env so the Trigger.dev SDK picks up the correct endpoint.
 * Call sites: wired in Phases 6–8 alongside loadTriggerConfig.
 */
export function applyTriggerEnv(cfg: TriggerConfig): void {
  process.env['TRIGGER_API_URL'] = cfg.apiUrl;
  process.env['TRIGGER_SECRET_KEY'] = cfg.apiKey;
}
