import type { ConfigBackend, SecretBackend } from '@minicoder/core';

export type TriggerBackend = 'self-host-single-node' | 'self-host-ha' | 'cloud';

export interface TriggerConfig {
  backend: TriggerBackend;
  apiUrl: string;
  apiKey: string;
  webhookSecret?: string;
}

const CLOUD_API_URL = 'https://api.trigger.dev';

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

  let webhookSecret: string | undefined;
  try {
    webhookSecret = await secrets.get('TRIGGERDEV_WEBHOOK_SECRET');
  } catch {
    webhookSecret = undefined;
  }

  return { backend, apiUrl, apiKey, webhookSecret };
}

export function applyTriggerEnv(cfg: TriggerConfig): void {
  process.env['TRIGGER_API_URL'] = cfg.apiUrl;
  process.env['TRIGGER_SECRET_KEY'] = cfg.apiKey;
}
