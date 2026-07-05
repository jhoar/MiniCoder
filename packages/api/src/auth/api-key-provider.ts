/**
 * Static API-key auth (CLAUDE.md's Orchestrator API Operational Constraints): no session/JWT
 * infra exists anywhere in the repo, and docs/07-security-and-secrets.md defers real hosted
 * OAuth/SSO sessions to future/hosted-profile work. `MINICODER_API_KEYS` is a JSON array of
 * `{key, id, role, actorKind, displayName?}`. Only the SHA-256 hash of each key is retained in
 * memory — raw keys are never compared or logged.
 */
import * as crypto from 'crypto';
import { z } from 'zod';
import { UserRole } from '@minicoder/core';
import type { ApiKeyIdentity } from './types.js';

const ApiKeyConfigSchema = z.object({
  key: z.string().min(1),
  id: z.string().min(1),
  role: z.nativeEnum(UserRole),
  actorKind: z.union([z.literal('human'), z.literal('system')]),
  displayName: z.string().optional(),
});
const ApiKeyConfigListSchema = z.array(ApiKeyConfigSchema);

function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey, 'utf-8').digest('hex');
}

export class ApiKeyProvider {
  private readonly byHash = new Map<string, ApiKeyIdentity>();

  constructor(configs: z.infer<typeof ApiKeyConfigSchema>[]) {
    for (const config of configs) {
      this.byHash.set(hashKey(config.key), {
        id: config.id,
        role: config.role,
        actorKind: config.actorKind,
        displayName: config.displayName,
      });
    }
  }

  resolve(rawKey: string): ApiKeyIdentity | null {
    return this.byHash.get(hashKey(rawKey)) ?? null;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ApiKeyProvider {
    const raw = env['MINICODER_API_KEYS'];
    if (!raw || raw.trim().length === 0) {
      throw new Error(
        'MINICODER_API_KEYS is required to start the Orchestrator API — a JSON array of ' +
          '{key, id, role, actorKind, displayName?}. See docs/07-security-and-secrets.md §4.',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`MINICODER_API_KEYS is not valid JSON: ${(err as Error).message}`);
    }
    const configs = ApiKeyConfigListSchema.parse(parsed);
    if (configs.length === 0) {
      throw new Error('MINICODER_API_KEYS must contain at least one key');
    }
    return new ApiKeyProvider(configs);
  }
}
