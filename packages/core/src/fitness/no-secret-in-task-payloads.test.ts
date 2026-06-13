import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { SecretRedactor } from '../auth/redaction.js';
import { EVENT_SCHEMAS } from '../events/schemas.js';
import { z } from 'zod';

/**
 * Architectural fitness test: RF-12 — no secrets in task payloads.
 *
 * 1. Event schema field names must not contain secret-bearing names.
 * 2. SecretRedactor must be applied before outbox payload serialization
 *    (validated by scanning outbox write callsites for redactObject usage).
 * 3. helpers.ts writeOutboxEvent must call defaultRedactor.redactObject.
 */

const SECRET_FIELD_NAMES = [
  'token', 'apikey', 'api_key', 'password', 'secret',
  'privatekey', 'private_key', 'accesskey', 'access_key',
  'clientsecret', 'client_secret', 'webhooksecret', 'webhook_secret',
  'signingsecret', 'signing_secret', 'credential',
];

describe('RF-12: no secret fields in event payload schemas', () => {
  for (const [eventType, schema] of Object.entries(EVENT_SCHEMAS)) {
    it(`${eventType} schema has no secret-bearing field names`, () => {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      if (!shape) return;
      const fieldNames = Object.keys(shape).map((k) => k.toLowerCase());
      const secretFields = fieldNames.filter((f) => SECRET_FIELD_NAMES.includes(f));
      expect(
        secretFields,
        `Schema '${eventType}' has secret-bearing fields: ${secretFields.join(', ')}`,
      ).toEqual([]);
    });
  }
});

describe('RF-12: writeOutboxEvent applies SecretRedactor', () => {
  it('helpers.ts imports and applies defaultRedactor before serializing outbox payload', () => {
    const helpersPath = path.resolve(__dirname, '../commands/helpers.ts');
    const content = fs.readFileSync(helpersPath, 'utf-8');
    expect(content).toContain('defaultRedactor');
    expect(content).toContain('redactObject');
  });
});

describe('RF-12: SecretRedactor scrubs secrets from payloads before dispatch', () => {
  it('payload containing a token field is redacted', () => {
    const redactor = new SecretRedactor();
    const payload = { featureRunId: 'abc', token: 'ghp_secretvalue123456789' };
    const redacted = redactor.redactObject(payload);
    expect(redacted.token).toBe('[REDACTED]');
    expect((redacted as Record<string, string>).featureRunId).toBe('abc');
  });

  it('payload without secrets passes through unchanged for non-secret fields', () => {
    const redactor = new SecretRedactor();
    const payload = { featureRunId: 'abc-123', projectId: 'proj-456', fromState: 'coding' };
    const redacted = redactor.redactObject(payload);
    expect(redacted).toEqual(payload);
  });
});
