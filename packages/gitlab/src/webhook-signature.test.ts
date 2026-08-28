import { describe, it, expect } from 'vitest';
import { verifyGitlabWebhookToken } from './webhook-signature.js';

describe('verifyGitlabWebhookToken', () => {
  it('accepts the current secret', () => {
    expect(verifyGitlabWebhookToken('current-secret', ['current-secret'])).toBe(true);
  });

  it('accepts the previous secret during a rotation window', () => {
    expect(verifyGitlabWebhookToken('previous-secret', ['current-secret', 'previous-secret'])).toBe(
      true,
    );
  });

  it('rejects a token that matches neither secret', () => {
    expect(verifyGitlabWebhookToken('wrong-secret', ['current-secret', 'previous-secret'])).toBe(
      false,
    );
  });

  it('rejects when no token header is present', () => {
    expect(verifyGitlabWebhookToken(undefined, ['current-secret'])).toBe(false);
    expect(verifyGitlabWebhookToken(null, ['current-secret'])).toBe(false);
  });

  it('rejects when no secrets are configured', () => {
    expect(verifyGitlabWebhookToken('current-secret', [])).toBe(false);
  });

  it('rejects an empty-string token even if an empty secret were somehow configured', () => {
    // Defense-in-depth: an empty token must never verify, regardless of secrets list contents.
    expect(verifyGitlabWebhookToken('', ['current-secret'])).toBe(false);
  });
});
