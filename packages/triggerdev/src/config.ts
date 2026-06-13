import type { ConfigBackend } from '@minicoder/core';

export type TriggerBackend = 'self-host-single-node' | 'self-host-ha' | 'cloud';

export interface TriggerConfig {
  backend: TriggerBackend;
  apiUrl: string;
  apiKey: string;
  webhookSecret?: string;
}

const CLOUD_API_URL = 'https://api.trigger.dev';

export function loadTriggerConfig(config: ConfigBackend): TriggerConfig {
  const raw = config.get('TRIGGERDEV_BACKEND') ?? 'self-host-single-node';
  const backend = raw as TriggerBackend;

  const apiUrl =
    backend === 'cloud' ? CLOUD_API_URL : config.getRequired('TRIGGERDEV_API_URL');

  const apiKey = config.getRequired('TRIGGERDEV_API_KEY');
  const webhookSecret = config.get('TRIGGERDEV_WEBHOOK_SECRET');

  return { backend, apiUrl, apiKey, webhookSecret };
}

export function applyTriggerEnv(cfg: TriggerConfig): void {
  process.env['TRIGGER_API_URL'] = cfg.apiUrl;
  process.env['TRIGGER_SECRET_KEY'] = cfg.apiKey;
}
