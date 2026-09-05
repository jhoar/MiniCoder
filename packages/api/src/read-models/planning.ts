/**
 * Read models for "specification inputs", "planning readiness", "clarification sessions", and
 * "implementation plans" (docs/01-system-specification.md §9).
 */
import type { DbClient } from '@minicoder/core';
import { listByCreatedAt, type CursorPage, type ListParams } from '../pagination.js';
import { getByIdOrThrow } from './helpers.js';

export interface SpecificationInputRow {
  id: string;
  project_id: string;
  content: string;
  content_type: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export function listSpecificationInputs(
  db: DbClient,
  projectId: string,
  params: ListParams,
): Promise<CursorPage<SpecificationInputRow>> {
  return listByCreatedAt<SpecificationInputRow>(
    db,
    {
      table: 'specification_inputs',
      columns: 'id, project_id, content, content_type, version, created_at, updated_at',
      where: 'project_id = ?',
      params: [projectId],
    },
    params,
  );
}

export interface PlanningReadinessRow {
  id: string;
  project_id: string;
  specification_input_id: string | null;
  status: string;
  summary: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export function listPlanningReadinessAssessments(
  db: DbClient,
  projectId: string,
  params: ListParams,
): Promise<CursorPage<PlanningReadinessRow>> {
  return listByCreatedAt<PlanningReadinessRow>(
    db,
    {
      table: 'planning_readiness_assessments',
      columns:
        'id, project_id, specification_input_id, status, summary, version, created_at, updated_at',
      where: 'project_id = ?',
      params: [projectId],
    },
    params,
  );
}

export interface PlanningGapRow {
  id: string;
  assessment_id: string;
  description: string;
  severity: string;
  resolution: string | null;
  resolved_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  clarification_session_id: string | null;
}

export interface PlanningAssumptionRow {
  id: string;
  assessment_id: string;
  description: string;
  confidence: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PlanningQuestionRow {
  id: string;
  assessment_id: string;
  question: string;
  answer: string | null;
  round: number;
  answered_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PlanningReadinessAssessmentDetail {
  assessment: PlanningReadinessRow;
  gaps: PlanningGapRow[];
  assumptions: PlanningAssumptionRow[];
  questions: PlanningQuestionRow[];
}

/** Includes the assessment's `planning_gaps`/`planning_assumptions`/`planning_questions` rows —
 * previously the bare `planning_readiness_assessments` row alone, with no way for any caller to
 * see the actual gaps/assumptions/questions an assessment produced short of a raw SQL query
 * against the database. Mirrors `getClarificationSession()`'s `{session, questions}` shape, one
 * level richer. */
export async function getPlanningReadinessAssessment(
  db: DbClient,
  id: string,
): Promise<PlanningReadinessAssessmentDetail> {
  const assessment = await getByIdOrThrow<PlanningReadinessRow>(
    db,
    'planning_readiness_assessments',
    'id, project_id, specification_input_id, status, summary, version, created_at, updated_at',
    id,
    'planning-readiness-assessment',
  );
  const gaps = await db.query<PlanningGapRow>(
    `SELECT id, assessment_id, description, severity, resolution, resolved_at, version, created_at, updated_at, clarification_session_id
     FROM planning_gaps WHERE assessment_id = ? ORDER BY created_at ASC, id ASC`,
    [id],
  );
  const assumptions = await db.query<PlanningAssumptionRow>(
    `SELECT id, assessment_id, description, confidence, version, created_at, updated_at
     FROM planning_assumptions WHERE assessment_id = ? ORDER BY created_at ASC, id ASC`,
    [id],
  );
  const questions = await db.query<PlanningQuestionRow>(
    `SELECT id, assessment_id, question, answer, round, answered_at, version, created_at, updated_at
     FROM planning_questions WHERE assessment_id = ? ORDER BY round ASC, created_at ASC, id ASC`,
    [id],
  );
  return { assessment, gaps, assumptions, questions };
}

export interface ClarificationSessionRow {
  id: string;
  project_id: string;
  specification_input_id: string | null;
  status: string;
  round: number;
  max_rounds: number;
  round_timeout_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export function listClarificationSessions(
  db: DbClient,
  projectId: string,
  params: ListParams,
): Promise<CursorPage<ClarificationSessionRow>> {
  return listByCreatedAt<ClarificationSessionRow>(
    db,
    {
      table: 'clarification_sessions',
      columns:
        'id, project_id, specification_input_id, status, round, max_rounds, round_timeout_at, version, created_at, updated_at',
      where: 'project_id = ?',
      params: [projectId],
    },
    params,
  );
}

export interface ClarificationQuestionRow {
  id: string;
  clarification_session_id: string;
  question: string;
  round: number;
  order_index: number;
  asked_at: string | null;
  answered_at: string | null;
  // Additive (Phase 15): `RecordClarificationAnswerCommand` requires `expectedQuestionVersion`,
  // but this row previously omitted `version` — no caller (the API had none before the Web UI)
  // could otherwise discover the value to submit. Mirrors the "small, additive API change"
  // precedent from Phase 14 (whoami/triggerdev-runs/human-required-items/status.version).
  version: number;
  // Additive (post-merge PR review fix, MEDIUM-5): the row previously carried no way to show
  // what was actually answered — the Web UI's clarification page could only render "Answered",
  // not the answer text itself. `clarification_answers.clarification_question_id` is UNIQUE, so
  // a plain LEFT JOIN is safe (at most one answer row per question) and needs no aggregation.
  // `null` for an unanswered question (`answered_at IS NULL`), the same nullability shape.
  answer_text: string | null;
}

export async function getClarificationSession(
  db: DbClient,
  id: string,
): Promise<{ session: ClarificationSessionRow; questions: ClarificationQuestionRow[] }> {
  const session = await getByIdOrThrow<ClarificationSessionRow>(
    db,
    'clarification_sessions',
    'id, project_id, specification_input_id, status, round, max_rounds, round_timeout_at, version, created_at, updated_at',
    id,
    'clarification-session',
  );
  const questions = await db.query<ClarificationQuestionRow>(
    `SELECT q.id, q.clarification_session_id, q.question, q.round, q.order_index, q.asked_at,
            q.answered_at, q.version, a.answer AS answer_text
     FROM clarification_questions q
     LEFT JOIN clarification_answers a ON a.clarification_question_id = q.id
     WHERE q.clarification_session_id = ? ORDER BY q.round ASC, q.order_index ASC`,
    [id],
  );
  return { session, questions };
}

export interface ImplementationPlanRow {
  id: string;
  project_id: string;
  assessment_id: string | null;
  state: string;
  title: string;
  summary: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export function listImplementationPlans(
  db: DbClient,
  projectId: string,
  params: ListParams,
): Promise<CursorPage<ImplementationPlanRow>> {
  return listByCreatedAt<ImplementationPlanRow>(
    db,
    {
      table: 'implementation_plans',
      columns:
        'id, project_id, assessment_id, state, title, summary, version, created_at, updated_at',
      where: 'project_id = ?',
      params: [projectId],
    },
    params,
  );
}

export function getImplementationPlan(db: DbClient, id: string): Promise<ImplementationPlanRow> {
  return getByIdOrThrow<ImplementationPlanRow>(
    db,
    'implementation_plans',
    'id, project_id, assessment_id, state, title, summary, version, created_at, updated_at',
    id,
    'implementation-plan',
  );
}
