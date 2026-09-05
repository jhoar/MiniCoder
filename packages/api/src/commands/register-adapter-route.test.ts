import { describe, it, expect } from 'vitest';
import { buildTestApp, TEST_OPERATOR_KEY, TEST_VIEWER_KEY } from '../test-helpers.js';

describe('POST /commands/register-adapter', () => {
  it('requires operator role or higher', async () => {
    const { app } = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/commands/register-adapter',
      headers: { authorization: `Bearer ${TEST_VIEWER_KEY}` },
      payload: {
        role: 'PlannerAgentAdapter',
        name: 'MockPlannerAdapter',
        implementation: 'mock',
        capabilities: ['can_generate_plan'],
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('requires role, name, implementation, and capabilities', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/commands/register-adapter',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { role: 'PlannerAgentAdapter' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('registers a fresh adapter and returns its id', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/commands/register-adapter',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: {
        role: 'PlannerAgentAdapter',
        name: 'MockPlannerAdapter',
        implementation: 'mock-v1',
        capabilities: ['can_generate_plan'],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ role: 'PlannerAgentAdapter', name: 'MockPlannerAdapter' });
    expect(typeof body.adapterId).toBe('string');
  });

  it('re-registering the same role/name updates rather than erroring (idempotent)', async () => {
    const { app } = await buildTestApp();
    const first = await app.inject({
      method: 'POST',
      url: '/commands/register-adapter',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: {
        role: 'PlannerAgentAdapter',
        name: 'MockPlannerAdapter',
        implementation: 'mock-v1',
        capabilities: ['can_generate_plan'],
      },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/commands/register-adapter',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: {
        role: 'PlannerAgentAdapter',
        name: 'MockPlannerAdapter',
        implementation: 'mock-v2',
        capabilities: ['can_generate_plan', 'can_generate_clarification_questions'],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).adapterId).toBe(JSON.parse(first.body).adapterId);
  });

  it('rejects an unrecognized capability token with a 400, not a 500', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/commands/register-adapter',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: {
        role: 'PlannerAgentAdapter',
        name: 'MockPlannerAdapter',
        implementation: 'mock-v1',
        capabilities: ['not_a_real_capability'],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).type).toBe('invalid-capability');
  });
});
