import { UserRole } from '../domain/states.js';
import type { ActorIdentity, AuthContext } from './types.js';

export interface LocalAuthConfig {
  readonly actorId: string;
  readonly role: UserRole;
  readonly displayName?: string;
  readonly sessionDurationMs?: number;
}

function generateCorrelationId(): string {
  return `corr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class LocalAuthProvider {
  private readonly config: LocalAuthConfig;

  constructor(config: LocalAuthConfig) {
    this.config = config;
  }

  issueContext(): AuthContext {
    const now = new Date();
    const durationMs = this.config.sessionDurationMs ?? 8 * 60 * 60 * 1000;
    const expiresAt = new Date(now.getTime() + durationMs);

    const actor: ActorIdentity = {
      id: this.config.actorId,
      role: this.config.role,
      actorKind: 'human',
      correlationId: generateCorrelationId(),
      displayName: this.config.displayName,
    };

    return {
      actor,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  issueSystemContext(): AuthContext {
    const now = new Date();
    const actor: ActorIdentity = {
      id: 'system',
      role: UserRole.ADMIN,
      actorKind: 'system',
      correlationId: generateCorrelationId(),
      displayName: 'MiniCoder System',
    };
    return {
      actor,
      issuedAt: now.toISOString(),
    };
  }
}
