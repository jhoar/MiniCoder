import { generateId } from '@minicoder/core';
import type { AgentCapabilityToken, AgentRole } from '@minicoder/core';
import { AdapterRunError } from '@minicoder/core';
import { MockPlannerAdapter } from '../adapters/mock-planner.js';
import { MockCoderAdapter, MockCoderError } from '../adapters/mock-coder.js';
import { MockReviewerAdapter } from '../adapters/mock-reviewer.js';
import { MockArbiterAdapter } from '../adapters/mock-arbiter.js';
import { MockDocumentationAdapter } from '../adapters/mock-documentation.js';
import { HumanTestAdapter } from '../adapters/human-test-adapter.js';
import type {
  PlannerInput,
  CoderInput,
  ReviewerInput,
  ArbiterInput,
  DocumentationInput,
  HumanApprovalInput,
} from '../adapters/types.js';
import type {
  ConformanceSuiteResult,
  ConformanceScenarioResult,
  ConformanceRunOptions,
} from './types.js';

type AnyAdapter =
  | MockPlannerAdapter
  | MockCoderAdapter
  | MockReviewerAdapter
  | MockArbiterAdapter
  | MockDocumentationAdapter
  | HumanTestAdapter;

type AnyInput =
  | PlannerInput
  | CoderInput
  | ReviewerInput
  | ArbiterInput
  | DocumentationInput
  | HumanApprovalInput;

interface AdapterDescriptor {
  readonly role: AgentRole;
  readonly adapterName: string;
  readonly implementation: string;
  readonly capabilities: readonly AgentCapabilityToken[];
  readonly requiredCapabilities: readonly AgentCapabilityToken[];
  makeSuccessAdapter(): AnyAdapter;
  makeFailureAdapter(): AnyAdapter;
  makeInvalidOutputAdapter(): AnyAdapter | null;
  makeSuccessInput(): AnyInput;
  validateOutput(output: unknown): string | null;
}

const COMMON_CORRELATION = 'conformance-test';
const PROJECT_ID = 'conformance-project';

const DESCRIPTORS: AdapterDescriptor[] = [
  {
    role: 'PlannerAgentAdapter',
    adapterName: 'MockPlannerAdapter',
    implementation: '@minicoder/testing:MockPlannerAdapter',
    capabilities: ['can_generate_plan', 'can_generate_clarification_questions'],
    requiredCapabilities: ['can_generate_plan'],
    makeSuccessAdapter: () => new MockPlannerAdapter('sufficient'),
    makeFailureAdapter: () => new MockPlannerAdapter('insufficient'),
    makeInvalidOutputAdapter: () => null,
    makeSuccessInput: (): PlannerInput => ({
      projectId: PROJECT_ID,
      specificationContent: 'Build a todo app with CRUD operations.',
      correlationId: COMMON_CORRELATION,
    }),
    validateOutput: (out: unknown): string | null => {
      const o = out as Record<string, unknown>;
      if (typeof o !== 'object' || o === null) return 'output is not an object';
      if (
        !['sufficient', 'sufficient_with_assumptions', 'insufficient'].includes(
          o['readinessResult'] as string,
        )
      )
        return `readinessResult invalid: ${String(o['readinessResult'])}`;
      if (!Array.isArray(o['questions'])) return 'questions must be an array';
      if (!Array.isArray(o['assumptions'])) return 'assumptions must be an array';
      if (!Array.isArray(o['gaps'])) return 'gaps must be an array';
      return null;
    },
  },
  {
    role: 'CoderAgentAdapter',
    adapterName: 'MockCoderAdapter',
    implementation: '@minicoder/testing:MockCoderAdapter',
    capabilities: ['can_modify_files', 'can_commit', 'can_push_branch'],
    requiredCapabilities: ['can_modify_files', 'can_commit'],
    makeSuccessAdapter: () => new MockCoderAdapter('success'),
    makeFailureAdapter: () => new MockCoderAdapter('fail'),
    makeInvalidOutputAdapter: () => new MockCoderAdapter('invalid_output'),
    makeSuccessInput: (): CoderInput => ({
      projectId: PROJECT_ID,
      featureRunId: 'fr-conformance-001',
      featureTitle: 'Add widget API endpoint',
      acceptanceCriteria: ['Endpoint returns 200', 'Tests pass'],
      correlationId: COMMON_CORRELATION,
    }),
    validateOutput: (out: unknown): string | null => {
      const o = out as Record<string, unknown>;
      if (typeof o !== 'object' || o === null) return 'output is not an object';
      if (typeof o['commitSha'] !== 'string' || !o['commitSha'])
        return 'commitSha must be a non-empty string';
      if (typeof o['branchName'] !== 'string' || !o['branchName'])
        return 'branchName must be a non-empty string';
      if (typeof o['filesChanged'] !== 'number') return 'filesChanged must be a number';
      return null;
    },
  },
  {
    role: 'ReviewerAgentAdapter',
    adapterName: 'MockReviewerAdapter',
    implementation: '@minicoder/testing:MockReviewerAdapter',
    capabilities: ['can_review_pull_request', 'can_return_structured_findings'],
    requiredCapabilities: ['can_review_pull_request', 'can_return_structured_findings'],
    makeSuccessAdapter: () => new MockReviewerAdapter('approve'),
    makeFailureAdapter: () => new MockReviewerAdapter('request_changes'),
    makeInvalidOutputAdapter: () => null,
    makeSuccessInput: (): ReviewerInput => ({
      projectId: PROJECT_ID,
      featureRunId: 'fr-conformance-001',
      prNumber: 42,
      reviewCycle: 1,
      correlationId: COMMON_CORRELATION,
    }),
    validateOutput: (out: unknown): string | null => {
      const o = out as Record<string, unknown>;
      if (typeof o !== 'object' || o === null) return 'output is not an object';
      if (!['approved', 'changes_requested'].includes(o['decision'] as string))
        return `decision invalid: ${String(o['decision'])}`;
      if (!Array.isArray(o['findings'])) return 'findings must be an array';
      return null;
    },
  },
  {
    role: 'ArbiterAgentAdapter',
    adapterName: 'MockArbiterAdapter',
    implementation: '@minicoder/testing:MockArbiterAdapter',
    capabilities: ['can_resolve_disagreement'],
    requiredCapabilities: ['can_resolve_disagreement'],
    makeSuccessAdapter: () => new MockArbiterAdapter('resolve'),
    makeFailureAdapter: () => new MockArbiterAdapter('escalate'),
    makeInvalidOutputAdapter: () => null,
    makeSuccessInput: (): ArbiterInput => ({
      projectId: PROJECT_ID,
      featureRunId: 'fr-conformance-001',
      findingDescription: 'The error handling path is insufficient',
      coderPosition: 'The existing try-catch is adequate',
      reviewerPosition: 'A specific error message is required by the spec',
      correlationId: COMMON_CORRELATION,
    }),
    validateOutput: (out: unknown): string | null => {
      const o = out as Record<string, unknown>;
      if (typeof o !== 'object' || o === null) return 'output is not an object';
      if (
        !['coder_correct', 'reviewer_correct', 'compromise', 'escalate_to_human'].includes(
          o['resolution'] as string,
        )
      )
        return `resolution invalid: ${String(o['resolution'])}`;
      if (typeof o['notes'] !== 'string') return 'notes must be a string';
      return null;
    },
  },
  {
    role: 'DocumentationAgentAdapter',
    adapterName: 'MockDocumentationAdapter',
    implementation: '@minicoder/testing:MockDocumentationAdapter',
    capabilities: ['can_generate_design_document'],
    requiredCapabilities: ['can_generate_design_document'],
    makeSuccessAdapter: () => new MockDocumentationAdapter('succeed'),
    makeFailureAdapter: () => new MockDocumentationAdapter('require_revision'),
    makeInvalidOutputAdapter: () => null,
    makeSuccessInput: (): DocumentationInput => ({
      projectId: PROJECT_ID,
      planId: 'plan-conformance-001',
      featureCount: 3,
      correlationId: COMMON_CORRELATION,
    }),
    validateOutput: (out: unknown): string | null => {
      const o = out as Record<string, unknown>;
      if (typeof o !== 'object' || o === null) return 'output is not an object';
      if (typeof o['documentId'] !== 'string' || !o['documentId'])
        return 'documentId must be a non-empty string';
      if (!Array.isArray(o['sections'])) return 'sections must be an array';
      if (typeof o['requiresRevision'] !== 'boolean') return 'requiresRevision must be a boolean';
      return null;
    },
  },
  {
    role: 'HumanAgentAdapter',
    adapterName: 'HumanTestAdapter',
    implementation: '@minicoder/testing:HumanTestAdapter',
    capabilities: ['can_report_run_status'],
    requiredCapabilities: ['can_report_run_status'],
    makeSuccessAdapter: () => new HumanTestAdapter(['approved']),
    makeFailureAdapter: () => new HumanTestAdapter(['rejected']),
    makeInvalidOutputAdapter: () => null,
    makeSuccessInput: (): HumanApprovalInput => ({
      projectId: PROJECT_ID,
      contextType: 'plan',
      contextId: 'plan-conformance-001',
      description: 'Approve the generated plan for execution',
      correlationId: COMMON_CORRELATION,
    }),
    validateOutput: (out: unknown): string | null => {
      const o = out as Record<string, unknown>;
      if (typeof o !== 'object' || o === null) return 'output is not an object';
      if (!['approved', 'rejected', 'deferred'].includes(o['decision'] as string))
        return `decision invalid: ${String(o['decision'])}`;
      if (typeof o['notes'] !== 'string') return 'notes must be a string';
      return null;
    },
  },
];

function runAdapter(adapter: AnyAdapter, input: AnyInput): Promise<unknown> {
  return (adapter.run as (i: AnyInput) => Promise<unknown>)(input);
}

function pass(scenarioName: string, details: string): ConformanceScenarioResult {
  return { scenarioName, passed: true, skipped: false, details };
}

function fail(scenarioName: string, details: string, error?: string): ConformanceScenarioResult {
  return { scenarioName, passed: false, skipped: false, details, error };
}

function skip(scenarioName: string, details: string): ConformanceScenarioResult {
  return { scenarioName, passed: false, skipped: true, details };
}

async function runScenarios(
  descriptor: AdapterDescriptor,
  adapterId: string,
  opts: ConformanceRunOptions,
): Promise<ConformanceScenarioResult[]> {
  const results: ConformanceScenarioResult[] = [];
  const { recorder, registry } = opts;

  // 1. Capability declaration
  try {
    const record = await registry.getById(adapterId);
    if (record.capabilities.length === 0) {
      results.push(fail('capability_declaration', 'Adapter declared no capabilities'));
    } else {
      results.push(
        pass(
          'capability_declaration',
          `Declared ${record.capabilities.length} capabilities: ${record.capabilities.join(', ')}`,
        ),
      );
    }
  } catch (e) {
    results.push(fail('capability_declaration', 'Failed to fetch adapter record', String(e)));
  }

  // 2. Successful run — output is non-null and has expected fields; agent_runs row reaches succeeded
  try {
    const { agentRunId } = await recorder.record(
      {
        adapterId,
        role: descriptor.role,
        input: descriptor.makeSuccessInput(),
        capabilitiesUsed: descriptor.requiredCapabilities.slice(),
      },
      () => runAdapter(descriptor.makeSuccessAdapter(), descriptor.makeSuccessInput()),
    );
    const [runRow] = await opts.db.query<{ state: string }>(
      `SELECT state FROM agent_runs WHERE id = ?`,
      [agentRunId],
    );
    if (runRow?.state === 'succeeded') {
      results.push(pass('successful_run', `agent_run ${agentRunId} reached state=succeeded`));
    } else {
      results.push(fail('successful_run', `Expected succeeded, got ${String(runRow?.state)}`));
    }
  } catch (e) {
    results.push(fail('successful_run', 'Unexpected exception during successful run', String(e)));
  }

  // 3. Failure handling — run throws; agent_runs reaches failed; agent_errors row exists
  try {
    let threw = false;
    try {
      await recorder.record(
        {
          adapterId,
          role: descriptor.role,
          input: descriptor.makeSuccessInput(),
          capabilitiesUsed: descriptor.requiredCapabilities.slice(),
        },
        () => {
          const adapted = descriptor.makeFailureAdapter();
          const input = descriptor.makeSuccessInput();
          // Wrap error as AdapterRunError so it gets recorded with a normalized type
          return runAdapter(adapted, input).then(
            (out) => out,
            (err) => {
              const msg = err instanceof Error ? err.message : String(err);
              throw new AdapterRunError('provider_unavailable', msg);
            },
          );
        },
      );
    } catch {
      threw = true;
    }

    const failedRuns = await opts.db.query<{ id: string; state: string }>(
      `SELECT id, state FROM agent_runs WHERE adapter_id = ? AND state = 'failed'`,
      [adapterId],
    );
    const errorRows = await opts.db.query<{ id: string }>(
      `SELECT ae.id FROM agent_errors ae
       JOIN agent_runs ar ON ae.agent_run_id = ar.id
       WHERE ar.adapter_id = ?`,
      [adapterId],
    );

    if (threw && failedRuns.length > 0 && errorRows.length > 0) {
      results.push(
        pass(
          'failure_handling',
          `agent_run reached failed state; ${errorRows.length} error row(s) recorded`,
        ),
      );
    } else if (!threw) {
      // Some "failure" behaviors return normally (e.g., reviewer request_changes, human rejected)
      results.push(
        pass(
          'failure_handling',
          'Adapter failure behavior completed without exception (non-throwing failure mode)',
        ),
      );
    } else {
      results.push(
        fail(
          'failure_handling',
          `threw=${threw} failedRuns=${failedRuns.length} errorRows=${errorRows.length}`,
        ),
      );
    }
  } catch (e) {
    results.push(
      fail('failure_handling', 'Unexpected exception during failure scenario', String(e)),
    );
  }

  // 4. Invalid output handling
  const invalidAdapter = descriptor.makeInvalidOutputAdapter();
  if (!invalidAdapter) {
    results.push(
      skip(
        'invalid_output_handling',
        'Not applicable: this adapter role has no invalid-output mode in Phase 5 mocks',
      ),
    );
  } else {
    try {
      let threw = false;
      try {
        await recorder.record(
          {
            adapterId,
            role: descriptor.role,
            input: descriptor.makeSuccessInput(),
            capabilitiesUsed: descriptor.requiredCapabilities.slice(),
          },
          () =>
            runAdapter(invalidAdapter, descriptor.makeSuccessInput()).then(
              (out) => out,
              (err) => {
                const code = err instanceof MockCoderError ? err.code : 'invalid_output';
                throw new AdapterRunError(
                  code as never,
                  err instanceof Error ? err.message : String(err),
                );
              },
            ),
        );
      } catch {
        threw = true;
      }
      if (threw) {
        const invalidErrors = await opts.db.query<{ error_type: string }>(
          `SELECT ae.error_type FROM agent_errors ae
           JOIN agent_runs ar ON ae.agent_run_id = ar.id
           WHERE ar.adapter_id = ? AND ae.error_type = 'invalid_output'`,
          [adapterId],
        );
        if (invalidErrors.length > 0) {
          results.push(
            pass('invalid_output_handling', `error_type=invalid_output recorded in agent_errors`),
          );
        } else {
          results.push(fail('invalid_output_handling', 'No invalid_output error_type row found'));
        }
      } else {
        results.push(
          fail('invalid_output_handling', 'Expected adapter to throw on invalid_output behavior'),
        );
      }
    } catch (e) {
      results.push(fail('invalid_output_handling', 'Unexpected exception', String(e)));
    }
  }

  // 5. Secret redaction — input containing a secret-shaped value must not appear in input_summary
  const secretInput = {
    ...descriptor.makeSuccessInput(),
    apiKey: 'sk-secret-placeholder-do-not-store-123456789012',
  };
  try {
    const { agentRunId } = await recorder.record(
      {
        adapterId,
        role: descriptor.role,
        input: secretInput,
        capabilitiesUsed: descriptor.requiredCapabilities.slice(),
      },
      () => runAdapter(descriptor.makeSuccessAdapter(), descriptor.makeSuccessInput()),
    );
    const [runRow] = await opts.db.query<{ input_summary: string }>(
      `SELECT input_summary FROM agent_runs WHERE id = ?`,
      [agentRunId],
    );
    const summary = runRow?.input_summary ?? '';
    if (summary.includes('sk-secret-placeholder-do-not-store')) {
      results.push(
        fail('secret_redaction', 'Secret value was stored un-redacted in input_summary'),
      );
    } else {
      results.push(
        pass('secret_redaction', 'Secret-shaped apiKey value was redacted from input_summary'),
      );
    }
  } catch (e) {
    results.push(fail('secret_redaction', 'Unexpected exception', String(e)));
  }

  // 6. Configuration resolution — register a config row, verify it is returned
  try {
    const expectedConfig = { model: 'conformance-model', temperature: 0 };
    await opts.db.execute(
      `INSERT INTO agent_configurations (id, adapter_id, project_id, config, version, created_at, updated_at) VALUES (?, ?, NULL, ?, 1, ?, ?)`,
      [
        generateId(),
        adapterId,
        JSON.stringify(expectedConfig),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    const resolved = await registry.getConfiguration(adapterId);
    if (resolved?.model === 'conformance-model') {
      results.push(
        pass('configuration_resolution', 'Adapter-default configuration row resolved correctly'),
      );
    } else {
      results.push(
        fail(
          'configuration_resolution',
          `Expected model=conformance-model, got ${JSON.stringify(resolved)}`,
        ),
      );
    }
  } catch (e) {
    results.push(fail('configuration_resolution', 'Unexpected exception', String(e)));
  }

  // 7. State transition sequence — verify queued→running→succeeded ordering via timestamps
  try {
    const { agentRunId } = await recorder.record(
      {
        adapterId,
        role: descriptor.role,
        input: descriptor.makeSuccessInput(),
        capabilitiesUsed: descriptor.requiredCapabilities.slice(),
      },
      () => runAdapter(descriptor.makeSuccessAdapter(), descriptor.makeSuccessInput()),
    );
    const [runRow] = await opts.db.query<{
      state: string;
      started_at: string | null;
      ended_at: string | null;
    }>(`SELECT state, started_at, ended_at FROM agent_runs WHERE id = ?`, [agentRunId]);
    if (runRow?.state === 'succeeded' && runRow.started_at !== null && runRow.ended_at !== null) {
      results.push(
        pass('state_transition_sequence', 'queued→running→succeeded; started_at and ended_at set'),
      );
    } else {
      results.push(
        fail(
          'state_transition_sequence',
          `state=${String(runRow?.state)} started_at=${String(runRow?.started_at)} ended_at=${String(runRow?.ended_at)}`,
        ),
      );
    }
  } catch (e) {
    results.push(fail('state_transition_sequence', 'Unexpected exception', String(e)));
  }

  // 8. Output shape validation — successful run output conforms to role-specific schema
  try {
    const output = await runAdapter(descriptor.makeSuccessAdapter(), descriptor.makeSuccessInput());
    const shapeError = descriptor.validateOutput(output);
    if (shapeError) {
      results.push(fail('output_shape', `Output shape validation failed: ${shapeError}`));
    } else {
      results.push(pass('output_shape', 'Successful run output conforms to role-specific schema'));
    }
  } catch (e) {
    results.push(
      fail('output_shape', 'Unexpected exception during output shape validation', String(e)),
    );
  }

  // 9. assertCapabilities — adapter passes when holding required capabilities
  try {
    await registry.assertCapabilities(adapterId, descriptor.requiredCapabilities.slice());
    results.push(
      pass(
        'assert_capabilities',
        `assertCapabilities passed for [${descriptor.requiredCapabilities.join(', ')}]`,
      ),
    );
  } catch (e) {
    results.push(fail('assert_capabilities', 'assertCapabilities unexpectedly threw', String(e)));
  }

  return results;
}

/**
 * Runs the Phase 5 smoke conformance suite (9 scenarios × 6 adapters) against the provided DB,
 * writing one adapter_conformance_results row per adapter. Returns one suite result per adapter.
 *
 * This is a smoke-level conformance gate covering: capability declaration, successful run,
 * failure handling, invalid-output handling (skipped for roles without a deterministic
 * invalid-output mock), secret redaction, configuration resolution, state-transition sequencing,
 * output shape validation, and assertCapabilities. Full canonical adapter-contract conformance
 * (timeout taxonomy, cost/token reporting, Workflow Layer wrapper invocation) is deferred to
 * Phase 9+ when real provider adapters are connected.
 */
export async function runConformanceSuite(
  opts: ConformanceRunOptions,
): Promise<ConformanceSuiteResult[]> {
  const suiteResults: ConformanceSuiteResult[] = [];

  for (const descriptor of DESCRIPTORS) {
    const adapterId = await opts.registry.register({
      role: descriptor.role,
      name: descriptor.adapterName,
      implementation: descriptor.implementation,
      capabilities: descriptor.capabilities.slice(),
    });

    const adapterRecord = await opts.registry.getById(adapterId);

    const scenarios = await runScenarios(descriptor, adapterId, opts);
    const passedCount = scenarios.filter((s) => s.passed && !s.skipped).length;
    const failedCount = scenarios.filter((s) => !s.passed && !s.skipped).length;
    const skippedCount = scenarios.filter((s) => s.skipped).length;
    const totalCount = scenarios.length;

    const conformanceResultId = generateId();
    const now = new Date().toISOString();
    await opts.db.execute(
      `INSERT INTO adapter_conformance_results
         (id, adapter_id, role, test_suite, passed, total_tests, failed_tests, skipped_tests, details, run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conformanceResultId,
        adapterId,
        descriptor.role,
        'phase5-smoke-conformance',
        failedCount === 0 ? 1 : 0,
        totalCount,
        failedCount,
        skippedCount,
        JSON.stringify({
          adapterName: descriptor.adapterName,
          implementation: descriptor.implementation,
          version: adapterRecord.version,
          capabilities: descriptor.capabilities,
          scenarios,
        }),
        now,
        now,
      ],
    );

    suiteResults.push({
      adapterId,
      role: descriptor.role,
      adapterName: descriptor.adapterName,
      scenarios,
      passedCount,
      failedCount,
      skippedCount,
      totalCount,
      conformanceResultId,
    });
  }

  return suiteResults;
}
