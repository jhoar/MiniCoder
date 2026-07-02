import { describe, it, expect } from 'vitest';
import { sign } from '@octokit/webhooks-methods';
import { verifyWebhookSignature } from './webhook-signature.js';

describe('verifyWebhookSignature', () => {
  const payload = JSON.stringify({ action: 'opened' });

  it('accepts a signature computed with the current secret', async () => {
    const signature = await sign('current-secret', payload);
    expect(await verifyWebhookSignature(payload, signature, ['current-secret'])).toBe(true);
  });

  it('accepts a signature computed with the previous secret during a rotation window', async () => {
    const signature = await sign('previous-secret', payload);
    expect(
      await verifyWebhookSignature(payload, signature, ['current-secret', 'previous-secret']),
    ).toBe(true);
  });

  it('rejects a signature that matches neither secret', async () => {
    const signature = await sign('wrong-secret', payload);
    expect(
      await verifyWebhookSignature(payload, signature, ['current-secret', 'previous-secret']),
    ).toBe(false);
  });

  it('rejects when no signature header is present', async () => {
    expect(await verifyWebhookSignature(payload, undefined, ['current-secret'])).toBe(false);
    expect(await verifyWebhookSignature(payload, null, ['current-secret'])).toBe(false);
  });

  it('rejects when no secrets are configured', async () => {
    const signature = await sign('current-secret', payload);
    expect(await verifyWebhookSignature(payload, signature, [])).toBe(false);
  });

  it('rejects a tampered payload even with the correct secret', async () => {
    const signature = await sign('current-secret', payload);
    const tampered = JSON.stringify({ action: 'closed' });
    expect(await verifyWebhookSignature(tampered, signature, ['current-secret'])).toBe(false);
  });
});
