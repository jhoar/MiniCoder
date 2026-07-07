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

export function getPlanningReadinessAssessment(
  db: DbClient,
  id: string,
): Promise<PlanningReadinessRow> {
  return getByIdOrThrow<PlanningReadinessRow>(
    db,
    'planning_readiness_assessments',
    'id, project_id, specification_input_id, status, summary, version, created_at, updated_at',
    id,
    'planning-readiness-assessment',
  );
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
    `SELECT id, clarification_session_id, question, round, order_index, asked_at, answered_at, version
     FROM clarification_questions WHERE clarification_session_id = ? ORDER BY round ASC, order_index ASC`,
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
