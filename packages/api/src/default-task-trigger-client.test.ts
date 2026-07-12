import { describe, it, expect, vi, afterEach } from 'vitest';

const triggerMock = vi.fn();

vi.mock('@trigger.dev/sdk/v3', () => ({
  tasks: { trigger: triggerMock },
}));

describe('resolveDefaultTaskTriggerClient (issue #61)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    triggerMock.mockReset();
    delete process.env['TRIGGER_SECRET_KEY'];
  });

  it('throws an actionable error when TRIGGER_SECRET_KEY is missing, without calling the SDK', async () => {
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
  });

  it('triggers run-coder by task ID with the payload and idempotency key, returning the run id', async () => {
    process.env['TRIGGER_SECRET_KEY'] = 'tr_test_123';
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
  });

  it('triggers run-review/run-merge-gate/run-design-doc by their exact canonical task IDs', async () => {
    process.env['TRIGGER_SECRET_KEY'] = 'tr_test_123';
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
});
