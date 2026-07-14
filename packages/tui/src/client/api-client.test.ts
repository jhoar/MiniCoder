import { describe, it, expect, vi } from 'vitest';
import { ApiClient, ApiError } from './api-client.js';

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    // Not asserted by every test, but useful for request-shape assertions below.
    _url: url,
    _init: init,
  })) as unknown as typeof fetch;
}

describe('ApiClient', () => {
  it('sends an Authorization bearer header and parses a CursorPage response', async () => {
    const fetchImpl = fakeFetch(200, { items: [{ id: '1' }], nextCursor: null });
    const client = new ApiClient({ baseUrl: 'http://localhost:4000', apiKey: 'k1', fetchImpl });

    const page = await client.listFeatures('project-1');

    expect(page.items).toEqual([{ id: '1' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/features?projectId=project-1');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer k1');
  });

  it('throws a typed ApiError with the parsed problem-details body on a non-2xx response', async () => {
    const problem = {
      type: 'not-found',
      title: 'Resource not found',
      status: 404,
      detail: 'feature-request abc not found',
    };
    const fetchImpl = fakeFetch(404, problem);
    const client = new ApiClient({ baseUrl: 'http://localhost:4000', apiKey: 'k1', fetchImpl });

    await expect(client.getStatus('missing-project')).rejects.toMatchObject({
      status: 404,
      problem,
    });
    await expect(client.getStatus('missing-project')).rejects.toBeInstanceOf(ApiError);
  });

  it('sends a POST body and Idempotency-Key header for pauseAutomation', async () => {
    const fetchImpl = fakeFetch(200, {
      command_id: 'c1',
      accepted: true,
      resulting_state: 'paused_by_operator',
      emitted_event_ids: [],
    });
    const client = new ApiClient({ baseUrl: 'http://localhost:4000', apiKey: 'k1', fetchImpl });

    const result = await client.pauseAutomation('project-1', 3, 'idem-key-1');

    expect(result.resulting_state).toBe('paused_by_operator');
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/commands/pause-automation');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-key-1');
    expect(JSON.parse(init.body as string)).toEqual({ projectId: 'project-1', expectedVersion: 3 });
  });

  it('omits undefined query parameters rather than sending them as literal "undefined"', async () => {
    const fetchImpl = fakeFetch(200, { items: [], nextCursor: null });
    const client = new ApiClient({ baseUrl: 'http://localhost:4000', apiKey: 'k1', fetchImpl });

    await client.listAgentRuns({ projectId: 'p1' });

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('projectId=p1');
    expect(String(url)).not.toContain('featureRunId');
  });

  // Previously curl-only generic-dispatch/task-enqueue commands (USER-MANUAL.md §5.0/§5.0.1) —
  // one request-shape assertion per new method is enough; the CLI wrapper tests cover the
  // version-fetch/idempotency-key-minting behavior built on top of these.

  it('sends ingestSpecification to the generic dispatch route with the right body', async () => {
    const fetchImpl = fakeFetch(200, {
      command_id: 'c1',
      accepted: true,
      resulting_state: 'ingested',
      emitted_event_ids: [],
    });
    const client = new ApiClient({ baseUrl: 'http://localhost:4000', apiKey: 'k1', fetchImpl });

    await client.ingestSpecification('project-1', 'the spec text', 'text/plain', 'idem-1');

    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/commands/ingest-specification');
    expect(JSON.parse(init.body as string)).toEqual({
      projectId: 'project-1',
      content: 'the spec text',
      contentType: 'text/plain',
    });
  });

  it('sends recordClarificationAnswer with expectedQuestionVersion', async () => {
    const fetchImpl = fakeFetch(200, {
      command_id: 'c1',
      accepted: true,
      resulting_state: 'clarification_required',
      emitted_event_ids: [],
    });
    const client = new ApiClient({ baseUrl: 'http://localhost:4000', apiKey: 'k1', fetchImpl });

    await client.recordClarificationAnswer('q1', 's1', 'project-1', 'the answer', 2, 'idem-1');

    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/commands/record-clarification-answer');
    expect(JSON.parse(init.body as string)).toEqual({
      clarificationQuestionId: 'q1',
      clarificationSessionId: 's1',
      projectId: 'project-1',
      answer: 'the answer',
      expectedQuestionVersion: 2,
    });
  });

  it('sends approveBudgetOverride with the required approvedBudgetPolicyId', async () => {
    const fetchImpl = fakeFetch(200, {
      command_id: 'c1',
      accepted: true,
      resulting_state: 'running',
      emitted_event_ids: [],
    });
    const client = new ApiClient({ baseUrl: 'http://localhost:4000', apiKey: 'k1', fetchImpl });

    await client.approveBudgetOverride('project-1', 5, 'extra spend approved', 'policy-1', 'idem-1');

    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/commands/approve-budget-override');
    expect(JSON.parse(init.body as string)).toEqual({
      projectId: 'project-1',
      expectedVersion: 5,
      overrideReason: 'extra spend approved',
      approvedBudgetPolicyId: 'policy-1',
    });
  });

  it('sends requestCoderRun to the enqueue route and returns the 202 body', async () => {
    const fetchImpl = fakeFetch(202, { triggerdevRunId: 'run-1', accepted: true });
    const client = new ApiClient({ baseUrl: 'http://localhost:4000', apiKey: 'k1', fetchImpl });

    const result = await client.requestCoderRun('project-1', 'fr1', 'CodexCoderAdapter', 'idem-1');

    expect(result).toEqual({ triggerdevRunId: 'run-1', accepted: true });
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/commands/request-coder-run');
    expect(JSON.parse(init.body as string)).toEqual({
      projectId: 'project-1',
      featureRunId: 'fr1',
      coderAdapterName: 'CodexCoderAdapter',
    });
  });
});
