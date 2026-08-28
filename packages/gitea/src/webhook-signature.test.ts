import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { verifyGiteaWebhookSignature } from './webhook-signature.js';

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

describe('verifyGiteaWebhookSignature', () => {
  const payload = JSON.stringify({ action: 'opened' });

  it('accepts a signature computed with the current secret', () => {
    const signature = sign('current-secret', payload);
    expect(verifyGiteaWebhookSignature(payload, signature, ['current-secret'])).toBe(true);
  });

  it('accepts a signature computed with the previous secret during a rotation window', () => {
    const signature = sign('previous-secret', payload);
    expect(
      verifyGiteaWebhookSignature(payload, signature, ['current-secret', 'previous-secret']),
    ).toBe(true);
  });

  it('rejects a signature that matches neither secret', () => {
    const signature = sign('wrong-secret', payload);
    expect(
      verifyGiteaWebhookSignature(payload, signature, ['current-secret', 'previous-secret']),
    ).toBe(false);
  });

  it('rejects when no signature header is present', () => {
    expect(verifyGiteaWebhookSignature(payload, undefined, ['current-secret'])).toBe(false);
    expect(verifyGiteaWebhookSignature(payload, null, ['current-secret'])).toBe(false);
  });

  it('rejects when no secrets are configured', () => {
    const signature = sign('current-secret', payload);
    expect(verifyGiteaWebhookSignature(payload, signature, [])).toBe(false);
  });

  it('rejects a tampered payload even with the correct secret', () => {
    const signature = sign('current-secret', payload);
    const tampered = JSON.stringify({ action: 'closed' });
    expect(verifyGiteaWebhookSignature(tampered, signature, ['current-secret'])).toBe(false);
  });

  it('does not expect a "sha256=" prefix the way GitHub\'s format does', () => {
    // A GitHub-style prefixed signature must NOT verify against Gitea's bare-hex-digest format.
    const signature = `sha256=${sign('current-secret', payload)}`;
    expect(verifyGiteaWebhookSignature(payload, signature, ['current-secret'])).toBe(false);
  });
});
