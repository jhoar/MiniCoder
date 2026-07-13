import { describe, it, expect, vi, afterEach } from 'vitest';

const triggerMock = vi.fn();
const configureMock = vi.fn();

vi.mock('@trigger.dev/sdk/v3', () => ({
  tasks: { trigger: triggerMock },
  configure: configureMock,
}));

describe('resolveDefaultTaskTriggerClient (issue #61)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    triggerMock.mockReset();
    configureMock.mockReset();
    delete process.env['TRIGGER_SECRET_KEY'];
    delete process.env['TRIGGER_API_URL'];
  });

  it('throws an actionable error when TRIGGER_SECRET_KEY is missing, without calling the SDK', async () => {
    process.env['TRIGGER_API_URL'] = 'https://trigger.internal.example.com';
    const { resolveDefaultTaskTriggerClient } = await import('./default-task-trigger-client.js');
    const client = resolveDefaultTaskTriggerClient();

    await expect(
      client.triggerRunCoder({
        projectId: 'proj-1',
        featureRunId: 'run-1',
        coderAdapterName: 'CodexCoderAdapter',
        correlationId: 'corr-1',
        idempotencyKey: 'idem-1',
      }),
    ).rejects.toThrow(/TRIGGER_SECRET_KEY/);
    expect(triggerMock).not.toHaveBeenCalled();
    expect(configureMock).not.toHaveBeenCalled();
  });

  // PR #73 review fix (MEDIUM-2): TRIGGER_API_URL must be required too, not left to the SDK's own
  // silent fallback to Trigger.dev Cloud's hosted API URL.
  it('throws an actionable error when TRIGGER_API_URL is missing, without calling the SDK', async () => {
    process.env['TRIGGER_SECRET_KEY'] = 'tr_test_123';
    const { resolveDefaultTaskTriggerClient } = await import('./default-task-trigger-client.js');
    const client = resolveDefaultTaskTriggerClient();

    await expect(
      client.triggerRunCoder({
        projectId: 'proj-1',
        featureRunId: 'run-1',
        coderAdapterName: 'CodexCoderAdapter',
        correlationId: 'corr-1',
        idempotencyKey: 'idem-1',
      }),
    ).rejects.toThrow(/TRIGGER_API_URL/);
    expect(triggerMock).not.toHaveBeenCalled();
    expect(configureMock).not.toHaveBeenCalled();
  });

  // PR #73 review fix (round 2, MEDIUM-1): TRIGGER_API_URL was required but not URL-validated.
  it('throws an actionable error for a malformed TRIGGER_API_URL', async () => {
    process.env['TRIGGER_SECRET_KEY'] = 'tr_test_123';
    process.env['TRIGGER_API_URL'] = 'not-a-url';
    const { resolveDefaultTaskTriggerClient } = await import('./default-task-trigger-client.js');
    const client = resolveDefaultTaskTriggerClient();

    await expect(
      client.triggerRunCoder({
        projectId: 'proj-1',
        featureRunId: 'run-1',
        coderAdapterName: 'CodexCoderAdapter',
        correlationId: 'corr-1',
        idempotencyKey: 'idem-1',
      }),
    ).rejects.toThrow(/not a valid URL/);
    expect(triggerMock).not.toHaveBeenCalled();
    expect(configureMock).not.toHaveBeenCalled();
  });

  it('throws an actionable error for a TRIGGER_API_URL with an unsupported scheme', async () => {
    process.env['TRIGGER_SECRET_KEY'] = 'tr_test_123';
    process.env['TRIGGER_API_URL'] = 'ftp://trigger.internal.example.com';
    const { resolveDefaultTaskTriggerClient } = await import('./default-task-trigger-client.js');
    const client = resolveDefaultTaskTriggerClient();

    await expect(
      client.triggerRunCoder({
        projectId: 'proj-1',
        featureRunId: 'run-1',
        coderAdapterName: 'CodexCoderAdapter',
        correlationId: 'corr-1',
        idempotencyKey: 'idem-1',
      }),
    ).rejects.toThrow(/http: or https:/);
    expect(triggerMock).not.toHaveBeenCalled();
    expect(configureMock).not.toHaveBeenCalled();
  });

  it('triggers run-coder by task ID with the payload and idempotency key, returning the run id', async () => {
    process.env['TRIGGER_SECRET_KEY'] = 'tr_test_123';
    process.env['TRIGGER_API_URL'] = 'https://trigger.internal.example.com';
    triggerMock.mockResolvedValue({ id: 'run_abc123' });
    const { resolveDefaultTaskTriggerClient } = await import('./default-task-trigger-client.js');
    const client = resolveDefaultTaskTriggerClient();

    const payload = {
      projectId: 'proj-1',
      featureRunId: 'run-1',
      coderAdapterName: 'CodexCoderAdapter',
      correlationId: 'corr-1',
      idempotencyKey: 'idem-1',
    };
    const result = await client.triggerRunCoder(payload);

    expect(result).toEqual({ triggerdevRunId: 'run_abc123' });
    expect(triggerMock).toHaveBeenCalledWith('run-coder', payload, { idempotencyKey: 'idem-1' });
    expect(configureMock).toHaveBeenCalledWith({
      baseURL: 'https://trigger.internal.example.com/',
      accessToken: 'tr_test_123',
    });
  });

  it('triggers run-review/run-merge-gate/run-design-doc by their exact canonical task IDs', async () => {
    process.env['TRIGGER_SECRET_KEY'] = 'tr_test_123';
    process.env['TRIGGER_API_URL'] = 'https://trigger.internal.example.com';
    triggerMock.mockResolvedValue({ id: 'run_xyz' });
    const { resolveDefaultTaskTriggerClient } = await import('./default-task-trigger-client.js');
    const client = resolveDefaultTaskTriggerClient();

    await client.triggerRunReview({
      projectId: 'p',
      featureRunId: 'f',
      reviewerAdapterName: 'ClaudeReviewerAdapter',
      correlationId: 'c',
      idempotencyKey: 'k1',
    });
    await client.triggerRunMergeGate({
      projectId: 'p',
      featureRunId: 'f',
      correlationId: 'c',
      idempotencyKey: 'k2',
    });
    await client.triggerRunDesignDoc({
      projectId: 'p',
      documentationAdapterName: 'ClaudeDocumentationAdapter',
      correlationId: 'c',
      idempotencyKey: 'k3',
    });

    expect(triggerMock.mock.calls[0]?.[0]).toBe('run-review');
    expect(triggerMock.mock.calls[1]?.[0]).toBe('run-merge-gate');
    expect(triggerMock.mock.calls[2]?.[0]).toBe('run-design-doc');
  });

  // PR #73 review fix (LOW-3): the four task ids this client triggers must stay members of the
  // canonical ALL_TASK_IDS list -- a contract test, on top of the TaskId compile-time constraint
  // already on triggerTask()'s signature.
  it('only triggers task ids that are members of the canonical ALL_TASK_IDS list', async () => {
    process.env['TRIGGER_SECRET_KEY'] = 'tr_test_123';
    process.env['TRIGGER_API_URL'] = 'https://trigger.internal.example.com';
    triggerMock.mockResolvedValue({ id: 'run_xyz' });
    const { ALL_TASK_IDS } = await import('@minicoder/triggerdev');
    const { resolveDefaultTaskTriggerClient } = await import('./default-task-trigger-client.js');
    const client = resolveDefaultTaskTriggerClient();

    await client.triggerRunCoder({
      projectId: 'p',
      featureRunId: 'f',
      coderAdapterName: 'CodexCoderAdapter',
      correlationId: 'c',
      idempotencyKey: 'k0',
    });
    await client.triggerRunReview({
      projectId: 'p',
      featureRunId: 'f',
      reviewerAdapterName: 'ClaudeReviewerAdapter',
      correlationId: 'c',
      idempotencyKey: 'k1',
    });
    await client.triggerRunMergeGate({
      projectId: 'p',
      featureRunId: 'f',
      correlationId: 'c',
      idempotencyKey: 'k2',
    });
    await client.triggerRunDesignDoc({
      projectId: 'p',
      documentationAdapterName: 'ClaudeDocumentationAdapter',
      correlationId: 'c',
      idempotencyKey: 'k3',
    });

    const usedTaskIds = triggerMock.mock.calls.map((call) => call[0]);
    expect(usedTaskIds).toEqual(['run-coder', 'run-review', 'run-merge-gate', 'run-design-doc']);
    for (const taskId of usedTaskIds) {
      expect(ALL_TASK_IDS).toContain(taskId);
    }
  });
});
