/**
 * One render function per docs/05 §4 command view. Each takes already-fetched data (fetching
 * happens in the `packages/cli` command action, via `ApiClient`) and returns a plain Ink element
 * — keeping these pure and easy to unit-test with `ink-testing-library`.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type {
  CursorPage,
  ImplementationPlanRow,
  PlanningReadinessRow,
  ClarificationSessionRow,
  ClarificationQuestionRow,
  FeatureRequestRow,
  HumanRequiredItemRow,
  FeatureRunRow,
  PullRequestRow,
  AgentRunRow,
  AgentAdapterRow,
  AgentConfigurationRow,
  ReviewFindingRow,
  DisagreementRow,
  CostRecordRow,
  BudgetPolicyRow,
  ArtifactExportRow,
  DesignDocumentRow,
  DesignDocumentSectionRow,
  DoctorResult,
  TriggerdevRunRow,
} from '@minicoder/api';
import type { ProjectStatus, WhoamiResponse } from './client/api-client.js';
import { Table, type Column } from './components/Table.js';
import { KeyValue, type Field } from './components/KeyValue.js';
import { StatusBadge } from './components/StatusBadge.js';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{title}</Text>
      {children}
    </Box>
  );
}

function Footer({ nextCursor }: { nextCursor: string | null }) {
  if (!nextCursor) return null;
  return <Text dimColor>next cursor: {nextCursor}</Text>;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export function renderStatusView(props: {
  status: ProjectStatus;
  whoami: WhoamiResponse;
  triggerdevRuns: CursorPage<TriggerdevRunRow>;
  doctor?: DoctorResult;
}): React.ReactElement {
  const { status, whoami, triggerdevRuns, doctor } = props;
  const fields: Field[] = [
    {
      label: 'Project',
      value: status.project ? `${status.project.name} (${status.project.id})` : '(not found)',
    },
    {
      label: 'Project state',
      value: status.project ? <StatusBadge state={status.project.state} /> : '-',
    },
    {
      label: 'Automation state',
      value: status.workflowState ? (
        <StatusBadge state={status.workflowState.automation_state} />
      ) : (
        '-'
      ),
    },
    { label: 'Active feature run', value: status.workflowState?.active_feature_run_id ?? '(none)' },
    { label: 'Workflow version', value: String(status.workflowState?.version ?? '-') },
    { label: 'Pending outbox events', value: String(status.pendingOutboxCount) },
    {
      label: 'Acting as',
      value: `${whoami.displayName ?? whoami.id} (${whoami.role}/${whoami.actorKind})`,
    },
  ];

  const runColumns: Column<TriggerdevRunRow>[] = [
    { header: 'Task', width: 20, render: (r) => r.triggerdev_task_id },
    { header: 'Status', width: 10, render: (r) => <StatusBadge state={r.triggerdev_status} /> },
    { header: 'Feature run', width: 18, render: (r) => r.linked_feature_run_id ?? '-' },
    { header: 'Last seen', width: 20, render: (r) => r.last_seen_at },
  ];

  return (
    <Box flexDirection="column">
      <Section title="Project status">
        <KeyValue fields={fields} />
      </Section>
      <Section title="Workflow Layer runs">
        <Table columns={runColumns} rows={triggerdevRuns.items} />
        <Footer nextCursor={triggerdevRuns.nextCursor} />
      </Section>
      {doctor ? (
        <Section title={`State health: ${doctor.healthy ? 'healthy' : 'issues found'}`}>
          <Table
            columns={[
              { header: 'Check', width: 20, render: (c) => c.name },
              { header: 'Severity', width: 10, render: (c) => <StatusBadge state={c.severity} /> },
              { header: 'Count', width: 6, render: (c) => String(c.count) },
            ]}
            rows={doctor.checks}
          />
        </Section>
      ) : (
        <Text dimColor>State health: unavailable (requires an operator-or-above API key)</Text>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

export function renderPlanView(props: {
  plans: CursorPage<ImplementationPlanRow>;
  readiness: CursorPage<PlanningReadinessRow>;
}): React.ReactElement {
  const planColumns: Column<ImplementationPlanRow>[] = [
    { header: 'Title', width: 22, render: (p) => p.title },
    { header: 'State', width: 20, render: (p) => <StatusBadge state={p.state} /> },
    { header: 'Version', width: 7, render: (p) => String(p.version) },
    { header: 'ID', width: 18, render: (p) => p.id },
  ];
  const readinessColumns: Column<PlanningReadinessRow>[] = [
    { header: 'Status', width: 22, render: (r) => <StatusBadge state={r.status} /> },
    { header: 'Summary', width: 30, render: (r) => r.summary ?? '-' },
    { header: 'ID', width: 18, render: (r) => r.id },
  ];
  return (
    <Box flexDirection="column">
      <Section title="Implementation plans">
        <Table columns={planColumns} rows={props.plans.items} />
        <Footer nextCursor={props.plans.nextCursor} />
      </Section>
      <Section title="Planning readiness assessments">
        <Table columns={readinessColumns} rows={props.readiness.items} />
        <Footer nextCursor={props.readiness.nextCursor} />
      </Section>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// clarification
// ---------------------------------------------------------------------------

export function renderClarificationView(props: {
  sessions: CursorPage<ClarificationSessionRow>;
  detail?: { session: ClarificationSessionRow; questions: ClarificationQuestionRow[] };
}): React.ReactElement {
  const sessionColumns: Column<ClarificationSessionRow>[] = [
    { header: 'Status', width: 20, render: (s) => <StatusBadge state={s.status} /> },
    { header: 'Round', width: 8, render: (s) => `${s.round}/${s.max_rounds}` },
    { header: 'ID', width: 18, render: (s) => s.id },
  ];
  return (
    <Box flexDirection="column">
      <Section title="Clarification sessions">
        <Table columns={sessionColumns} rows={props.sessions.items} />
        <Footer nextCursor={props.sessions.nextCursor} />
      </Section>
      {props.detail && (
        <Section title={`Questions for session ${props.detail.session.id}`}>
          <Table
            columns={[
              {
                header: 'Round',
                width: 5,
                render: (q: ClarificationQuestionRow) => String(q.round),
              },
              {
                header: 'Question',
                width: 44,
                render: (q: ClarificationQuestionRow) => q.question,
              },
              {
                header: 'Answered',
                width: 8,
                render: (q: ClarificationQuestionRow) => (q.answered_at ? 'yes' : 'no'),
              },
            ]}
            rows={props.detail.questions}
          />
        </Section>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// features / human-required
// ---------------------------------------------------------------------------

export function renderFeaturesView(page: CursorPage<FeatureRequestRow>): React.ReactElement {
  const columns: Column<FeatureRequestRow>[] = [
    { header: 'FR', width: 8, render: (f) => f.fr_id },
    { header: 'Title', width: 24, render: (f) => f.title },
    { header: 'Kind', width: 9, render: (f) => f.kind },
    { header: 'State', width: 22, render: (f) => <StatusBadge state={f.state} /> },
    { header: 'Priority', width: 8, render: (f) => String(f.priority) },
  ];
  return (
    <Section title="Feature queue">
      <Table columns={columns} rows={page.items} />
      <Footer nextCursor={page.nextCursor} />
    </Section>
  );
}

export function renderHumanRequiredView(
  page: CursorPage<HumanRequiredItemRow>,
): React.ReactElement {
  const columns: Column<HumanRequiredItemRow>[] = [
    { header: 'FR', width: 8, render: (r) => r.fr_id },
    { header: 'Title', width: 26, render: (r) => r.title },
    {
      header: 'State',
      width: 16,
      render: (r) => <StatusBadge state={r.current_execution_state} />,
    },
    { header: 'Feature run', width: 18, render: (r) => r.feature_run_id },
  ];
  return (
    <Section title="Human-required items">
      <Table columns={columns} rows={page.items} />
      <Footer nextCursor={page.nextCursor} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// active
// ---------------------------------------------------------------------------

export function renderActiveFeatureView(props: {
  automationState: string;
  activeFeatureRun: FeatureRunRow | null;
  pullRequest?: PullRequestRow | null;
}): React.ReactElement {
  const fields: Field[] = [
    { label: 'Automation state', value: <StatusBadge state={props.automationState} /> },
    {
      label: 'Active feature run',
      value: props.activeFeatureRun ? props.activeFeatureRun.id : '(none)',
    },
  ];
  if (props.activeFeatureRun) {
    fields.push(
      {
        label: 'Execution state',
        value: <StatusBadge state={props.activeFeatureRun.current_execution_state} />,
      },
      { label: 'Attempt', value: String(props.activeFeatureRun.attempt_no) },
      { label: 'Outcome', value: props.activeFeatureRun.outcome ?? '(pending)' },
    );
  }
  if (props.pullRequest) {
    fields.push(
      { label: 'PR', value: `#${props.pullRequest.pr_number} (${props.pullRequest.branch_name})` },
      { label: 'PR state', value: <StatusBadge state={props.pullRequest.state} /> },
      { label: 'Review state', value: <StatusBadge state={props.pullRequest.review_state} /> },
      { label: 'CI status', value: <StatusBadge state={props.pullRequest.ci_status} /> },
    );
  }
  return (
    <Section title="Active feature">
      <KeyValue fields={fields} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

export function renderRunsView(page: CursorPage<AgentRunRow>): React.ReactElement {
  const columns: Column<AgentRunRow>[] = [
    { header: 'Role', width: 12, render: (r) => r.role },
    { header: 'State', width: 10, render: (r) => <StatusBadge state={r.state} /> },
    { header: 'Adapter', width: 16, render: (r) => r.adapter_id },
    {
      header: 'Cost (USD)',
      width: 10,
      // PostgreSQL's NUMERIC(12,6) column comes back from the `pg` driver as a string, not a
      // number (SQLite returns a real number) — coerce defensively rather than assuming the
      // `AgentRunRow.cost_usd: number | null` type is accurate for every dialect.
      render: (r) => {
        if (r.cost_usd == null) return '-';
        const cost = Number(r.cost_usd);
        return Number.isFinite(cost) ? cost.toFixed(4) : String(r.cost_usd);
      },
    },
    { header: 'Feature run', width: 16, render: (r) => r.feature_run_id ?? '-' },
  ];
  return (
    <Section title="Agent runs">
      <Table columns={columns} rows={page.items} />
      <Footer nextCursor={page.nextCursor} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// findings
// ---------------------------------------------------------------------------

export function renderFindingsView(page: CursorPage<ReviewFindingRow>): React.ReactElement {
  const columns: Column<ReviewFindingRow>[] = [
    { header: 'Severity', width: 20, render: (f) => <StatusBadge state={f.severity} /> },
    { header: 'Cycle', width: 6, render: (f) => String(f.review_cycle) },
    { header: 'Description', width: 36, render: (f) => f.description },
    { header: 'Resolved', width: 8, render: (f) => (f.resolved ? 'yes' : 'no') },
  ];
  return (
    <Section title="Review findings">
      <Table columns={columns} rows={page.items} />
      <Footer nextCursor={page.nextCursor} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// disagreements
// ---------------------------------------------------------------------------

export function renderDisagreementsView(page: CursorPage<DisagreementRow>): React.ReactElement {
  const columns: Column<DisagreementRow>[] = [
    { header: 'State', width: 10, render: (d) => <StatusBadge state={d.state} /> },
    { header: 'Cycle', width: 6, render: (d) => String(d.review_cycle) },
    { header: 'Resolution', width: 16, render: (d) => d.resolution ?? '-' },
    { header: 'Feature run', width: 18, render: (d) => d.feature_run_id },
  ];
  return (
    <Section title="Disagreements">
      <Table columns={columns} rows={page.items} />
      <Footer nextCursor={page.nextCursor} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// costs
// ---------------------------------------------------------------------------

export function renderCostsView(props: {
  costs: CursorPage<CostRecordRow>;
  budgets: CursorPage<BudgetPolicyRow>;
}): React.ReactElement {
  const costColumns: Column<CostRecordRow>[] = [
    { header: 'Scope', width: 10, render: (c) => c.scope },
    { header: 'Amount', width: 12, render: (c) => `${c.amount} ${c.currency}` },
    { header: 'Provider', width: 12, render: (c) => c.provider ?? '-' },
    { header: 'Recorded', width: 20, render: (c) => c.recorded_at },
  ];
  const budgetColumns: Column<BudgetPolicyRow>[] = [
    { header: 'Scope', width: 10, render: (b) => b.scope },
    {
      header: 'Soft limit',
      width: 10,
      render: (b) => (b.soft_limit != null ? String(b.soft_limit) : '-'),
    },
    {
      header: 'Hard limit',
      width: 10,
      render: (b) => (b.hard_limit != null ? String(b.hard_limit) : '-'),
    },
    { header: 'Active', width: 6, render: (b) => (b.is_active ? 'yes' : 'no') },
  ];
  return (
    <Box flexDirection="column">
      <Section title="Cost records">
        <Table columns={costColumns} rows={props.costs.items} />
        <Footer nextCursor={props.costs.nextCursor} />
      </Section>
      <Section title="Budget policies">
        <Table columns={budgetColumns} rows={props.budgets.items} />
        <Footer nextCursor={props.budgets.nextCursor} />
      </Section>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

export function renderArtifactsView(page: CursorPage<ArtifactExportRow>): React.ReactElement {
  const columns: Column<ArtifactExportRow>[] = [
    { header: 'Type', width: 14, render: (a) => a.artifact_type },
    { header: 'State', width: 12, render: (a) => <StatusBadge state={a.state} /> },
    { header: 'Format', width: 8, render: (a) => a.format },
    { header: 'Exported at', width: 20, render: (a) => a.exported_at ?? '-' },
  ];
  return (
    <Section title="Artifact exports">
      <Table columns={columns} rows={page.items} />
      <Footer nextCursor={page.nextCursor} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// adapters
// ---------------------------------------------------------------------------

export function renderAdaptersView(props: {
  adapters: CursorPage<AgentAdapterRow>;
  configurations: CursorPage<AgentConfigurationRow>;
}): React.ReactElement {
  const adapterColumns: Column<AgentAdapterRow>[] = [
    { header: 'Role', width: 16, render: (a) => a.role },
    { header: 'Name', width: 18, render: (a) => a.name },
    { header: 'Implementation', width: 18, render: (a) => a.implementation },
    { header: 'Active', width: 6, render: (a) => (a.is_active ? 'yes' : 'no') },
  ];
  const configColumns: Column<AgentConfigurationRow>[] = [
    { header: 'Adapter', width: 18, render: (c) => c.adapter_id },
    { header: 'Project', width: 18, render: (c) => c.project_id ?? '(default)' },
    { header: 'Version', width: 7, render: (c) => String(c.version) },
  ];
  return (
    <Box flexDirection="column">
      <Section title="Agent adapters">
        <Table columns={adapterColumns} rows={props.adapters.items} />
        <Footer nextCursor={props.adapters.nextCursor} />
      </Section>
      <Section title="Agent configurations">
        <Table columns={configColumns} rows={props.configurations.items} />
        <Footer nextCursor={props.configurations.nextCursor} />
      </Section>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// design-doc
// ---------------------------------------------------------------------------

export function renderDesignDocView(props: {
  documents: CursorPage<DesignDocumentRow>;
  detail?: { document: DesignDocumentRow; sections: DesignDocumentSectionRow[] };
}): React.ReactElement {
  const docColumns: Column<DesignDocumentRow>[] = [
    { header: 'State', width: 24, render: (d) => <StatusBadge state={d.state} /> },
    { header: 'Version', width: 7, render: (d) => String(d.version) },
    { header: 'ID', width: 18, render: (d) => d.id },
  ];
  return (
    <Box flexDirection="column">
      <Section title="Design documents">
        <Table columns={docColumns} rows={props.documents.items} />
        <Footer nextCursor={props.documents.nextCursor} />
      </Section>
      {props.detail && (
        <Section title={`Sections for document ${props.detail.document.id}`}>
          <Table
            columns={[
              {
                header: 'Section',
                width: 26,
                render: (s: DesignDocumentSectionRow) => s.section_name,
              },
              {
                header: 'Content',
                width: 40,
                render: (s: DesignDocumentSectionRow) => (s.content ? s.content.slice(0, 40) : '-'),
              },
            ]}
            rows={props.detail.sections}
          />
        </Section>
      )}
      {props.documents.items.length === 0 && !props.detail && (
        <Text dimColor>
          No design document yet — generation/revision/approval commands ship in Phase 17.
        </Text>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// pause / resume confirmation
// ---------------------------------------------------------------------------

export function renderCommandResultView(props: {
  command: string;
  projectId: string;
  resultingState: string;
}): React.ReactElement {
  return (
    <KeyValue
      fields={[
        { label: 'Command', value: props.command },
        { label: 'Project', value: props.projectId },
        { label: 'Resulting state', value: <StatusBadge state={props.resultingState} /> },
      ]}
    />
  );
}
