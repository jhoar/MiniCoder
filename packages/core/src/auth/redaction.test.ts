import { describe, it, expect } from 'vitest';
import { SecretRedactor, defaultRedactor } from './redaction.js';

describe('SecretRedactor', () => {
  const redactor = new SecretRedactor();

  it('redacts GitHub personal access token patterns', () => {
    const input = 'token: ghp_abc123def456ghi789jkl012mno345pqr678';
    const result = redactor.redact(input);
    expect(result).not.toContain('ghp_abc123def456ghi789jkl012mno345pqr678');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts secret fields in JSON strings', () => {
    const json = '{"token": "my-secret-value", "name": "alice"}';
    const result = redactor.redact(json);
    expect(result).not.toContain('my-secret-value');
    expect(result).toContain('[REDACTED]');
    expect(result).toContain('"name": "alice"');
  });

  it('redactObject redacts secret-named string fields', () => {
    const obj = { token: 'abc123', name: 'alice', apiKey: 'sk-secret' };
    const result = redactor.redactObject(obj);
    expect(result.token).toBe('[REDACTED]');
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.name).toBe('alice');
  });

  it('redactObject handles nested objects', () => {
    const obj = { config: { secret: 'my-secret', host: 'localhost' } };
    const result = redactor.redactObject(obj);
    expect(result.config.secret).toBe('[REDACTED]');
    expect(result.config.host).toBe('localhost');
  });

  it('redactObject handles arrays', () => {
    const obj = { tokens: [{ token: 'abc' }, { token: 'def' }] };
    const result = redactor.redactObject(obj);
    expect(result.tokens[0]?.token).toBe('[REDACTED]');
    expect(result.tokens[1]?.token).toBe('[REDACTED]');
  });

  it('redacts accessToken and refreshToken fields in JSON strings', () => {
    const json = '{"accessToken": "eyJhbGciOiJSUzI1NiJ9.payload", "refreshToken": "rt-secret"}';
    const result = redactor.redact(json);
    expect(result).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(result).not.toContain('rt-secret');
    expect(result).toContain('[REDACTED]');
  });

  it('redactObject redacts accessToken and refreshToken fields', () => {
    const obj = { accessToken: 'bearer-token', refreshToken: 'refresh-xyz', userId: '123' };
    const result = redactor.redactObject(obj);
    expect(result.accessToken).toBe('[REDACTED]');
    expect(result.refreshToken).toBe('[REDACTED]');
    expect(result.userId).toBe('123');
  });

  it('redacts Authorization Bearer header values', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig';
    const result = redactor.redact(input);
    expect(result).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(result).toContain('[REDACTED]');
  });

  it('leaves clean strings unchanged', () => {
    const clean = 'Hello, world! featureRunId: abc-123';
    expect(redactor.redact(clean)).toBe(clean);
  });

  it('exports a defaultRedactor instance', () => {
    expect(defaultRedactor).toBeInstanceOf(SecretRedactor);
  });

  describe('scanForSecrets', () => {
    it('flags a GitHub PAT without mutating the input', () => {
      const input = 'token: ghp_abc123def456ghi789jkl012mno345pqr678';
      const hits = redactor.scanForSecrets(input);
      expect(hits.length).toBeGreaterThan(0);
      expect(input).toContain('ghp_abc123def456ghi789jkl012mno345pqr678');
    });

    it('flags an OpenAI-shaped API key', () => {
      const hits = redactor.scanForSecrets('sk-' + 'a'.repeat(40));
      expect(hits.length).toBeGreaterThan(0);
    });

    it('flags a secret-named JSON field', () => {
      const hits = redactor.scanForSecrets('{"apiKey": "my-secret-value"}');
      expect(hits.length).toBeGreaterThan(0);
    });

    it('returns an empty array for clean content', () => {
      expect(redactor.scanForSecrets('Hello, world! featureRunId: abc-123')).toEqual([]);
    });

    it('does not false-positive on already-redacted content', () => {
      const redacted = redactor.redact('token: ghp_abc123def456ghi789jkl012mno345pqr678');
      expect(redactor.scanForSecrets(redacted)).toEqual([]);
    });
  });
});
