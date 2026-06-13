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

  it('leaves clean strings unchanged', () => {
    const clean = 'Hello, world! featureRunId: abc-123';
    expect(redactor.redact(clean)).toBe(clean);
  });

  it('exports a defaultRedactor instance', () => {
    expect(defaultRedactor).toBeInstanceOf(SecretRedactor);
  });
});
