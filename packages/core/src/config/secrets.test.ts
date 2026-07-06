import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EnvSecretBackend, ManagedSecretBackend, MissingSecretError } from './secrets.js';

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

  it('set() writes and get() reads back the same process-local value', async () => {
    await backend.set('TEST_SET_KEY', 'written-value');
    await expect(backend.get('TEST_SET_KEY')).resolves.toBe('written-value');
    delete process.env['TEST_SET_KEY'];
  });

  it('delete() removes a previously-set key', async () => {
    await backend.set('TEST_DELETE_KEY', 'x');
    await backend.delete('TEST_DELETE_KEY');
    await expect(backend.get('TEST_DELETE_KEY')).rejects.toBeInstanceOf(MissingSecretError);
  });
});

type FetchArgs = Parameters<typeof fetch>;
type FetchInit = FetchArgs[1];

describe('ManagedSecretBackend', () => {
  function fakeFetch(
    handler: (url: string, init?: FetchInit) => { status: number; body?: unknown },
  ): typeof fetch {
    return (async (...args: FetchArgs) => {
      const [input, init] = args;
      const { status, body } = handler(String(input), init);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Awaited<ReturnType<typeof fetch>>;
    }) as typeof fetch;
  }

  it('throws a clear config error when baseUrl/apiKey are not supplied', () => {
    expect(() => new ManagedSecretBackend({})).toThrow(/MANAGED_SECRETS_URL/);
  });

  it('get() returns the value from a 200 response', async () => {
    const backend = new ManagedSecretBackend({
      baseUrl: 'https://secrets.example.com/',
      apiKey: 'k',
      fetchImpl: fakeFetch((url) => {
        expect(url).toBe('https://secrets.example.com/secrets/MY_KEY');
        return { status: 200, body: { value: 'the-secret' } };
      }),
    });
    await expect(backend.get('MY_KEY')).resolves.toBe('the-secret');
  });

  it('get() throws MissingSecretError on a 404', async () => {
    const backend = new ManagedSecretBackend({
      baseUrl: 'https://secrets.example.com',
      apiKey: 'k',
      fetchImpl: fakeFetch(() => ({ status: 404 })),
    });
    await expect(backend.get('MISSING')).rejects.toBeInstanceOf(MissingSecretError);
  });

  it('get() throws on an unexpected non-2xx response', async () => {
    const backend = new ManagedSecretBackend({
      baseUrl: 'https://secrets.example.com',
      apiKey: 'k',
      fetchImpl: fakeFetch(() => ({ status: 500 })),
    });
    await expect(backend.get('X')).rejects.toThrow(/HTTP 500/);
  });

  it('set() PUTs the value with bearer auth', async () => {
    const seen: { url: string; init?: FetchInit }[] = [];
    const backend = new ManagedSecretBackend({
      baseUrl: 'https://secrets.example.com',
      apiKey: 'the-api-key',
      fetchImpl: (async (...args: FetchArgs) => {
        const [input, init] = args;
        seen.push({ url: String(input), init });
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
        } as Awaited<ReturnType<typeof fetch>>;
      }) as typeof fetch,
    });
    await backend.set('MY_KEY', 'new-value');
    expect(seen).toHaveLength(1);
    const first = seen[0];
    if (!first) throw new Error('expected one fetch call');
    expect(first.url).toBe('https://secrets.example.com/secrets/MY_KEY');
    expect(first.init?.method).toBe('PUT');
    expect((first.init?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer the-api-key',
    );
    expect(first.init?.body).toBe(JSON.stringify({ value: 'new-value' }));
  });

  it('delete() treats a 404 as success', async () => {
    const backend = new ManagedSecretBackend({
      baseUrl: 'https://secrets.example.com',
      apiKey: 'k',
      fetchImpl: fakeFetch(() => ({ status: 404 })),
    });
    await expect(backend.delete('ALREADY_GONE')).resolves.toBeUndefined();
  });

  it('list() returns keys from the facade response', async () => {
    const backend = new ManagedSecretBackend({
      baseUrl: 'https://secrets.example.com',
      apiKey: 'k',
      fetchImpl: fakeFetch((url) => {
        expect(url).toBe('https://secrets.example.com/secrets?prefix=TEST_');
        return { status: 200, body: { keys: ['TEST_A', 'TEST_B'] } };
      }),
    });
    await expect(backend.list('TEST_')).resolves.toEqual(['TEST_A', 'TEST_B']);
  });

  it('list() tolerates a missing/malformed keys field', async () => {
    const backend = new ManagedSecretBackend({
      baseUrl: 'https://secrets.example.com',
      apiKey: 'k',
      fetchImpl: fakeFetch(() => ({ status: 200, body: {} })),
    });
    await expect(backend.list('TEST_')).resolves.toEqual([]);
  });
});
