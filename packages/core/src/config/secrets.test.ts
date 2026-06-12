import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EnvSecretBackend, FileSecretBackend, MissingSecretError } from './secrets.js';

describe('EnvSecretBackend', () => {
  const backend = new EnvSecretBackend();

  beforeEach(() => {
    process.env['TEST_SECRET_KEY'] = 'test-value-123';
    delete process.env['TEST_MISSING_KEY'];
  });

  afterEach(() => {
    delete process.env['TEST_SECRET_KEY'];
  });

  it('returns the value for a present key', async () => {
    const value = await backend.get('TEST_SECRET_KEY');
    expect(value).toBe('test-value-123');
  });

  it('throws MissingSecretError for a missing key', async () => {
    await expect(backend.get('TEST_MISSING_KEY')).rejects.toBeInstanceOf(MissingSecretError);
  });

  it('throws MissingSecretError for an empty string value', async () => {
    process.env['TEST_EMPTY_KEY'] = '';
    await expect(backend.get('TEST_EMPTY_KEY')).rejects.toBeInstanceOf(MissingSecretError);
    delete process.env['TEST_EMPTY_KEY'];
  });

  it('lists keys matching a prefix', async () => {
    process.env['TEST_ALPHA'] = 'a';
    process.env['TEST_BETA'] = 'b';
    const keys = await backend.list('TEST_');
    expect(keys).toContain('TEST_ALPHA');
    expect(keys).toContain('TEST_BETA');
    delete process.env['TEST_ALPHA'];
    delete process.env['TEST_BETA'];
  });
});

describe('FileSecretBackend', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `minicoder-test-secrets-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ MY_TOKEN: 'file-secret-value' }));
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it('returns the value from the file', async () => {
    const backend = new FileSecretBackend(tmpFile);
    const value = await backend.get('MY_TOKEN');
    expect(value).toBe('file-secret-value');
  });

  it('throws MissingSecretError for missing key', async () => {
    const backend = new FileSecretBackend(tmpFile);
    await expect(backend.get('NONEXISTENT_KEY')).rejects.toBeInstanceOf(MissingSecretError);
  });

  it('throws when file does not exist', async () => {
    const backend = new FileSecretBackend('/nonexistent/path/secrets.json');
    await expect(backend.get('ANY_KEY')).rejects.toThrow();
  });
});
