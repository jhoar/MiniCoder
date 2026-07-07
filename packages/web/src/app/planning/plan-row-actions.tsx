'use client';

import { CommandButton } from '../../components/command-button';
import {
  submitPlanForApprovalAction,
  approvePlanAction,
  activatePlanAction,
  exportPlanAction,
  exportBacklogAction,
} from './actions';

export function PlanRowActions({
  planId,
  projectId,
  state,
  version,
}: {
  planId: string;
  projectId: string;
  state: string;
  version: number;
}): JSX.Element {
  return (
    <div>
      {state === 'draft' && (
        <CommandButton
          label="Submit for approval"
          requiredRole="operator"
          action={() => submitPlanForApprovalAction(planId, projectId, version)}
        />
      )}
      {state === 'pending_approval' && (
        <CommandButton
          label="Approve"
          requiredRole="approver"
          confirmMessage="Approve this plan?"
          action={() => approvePlanAction(planId, projectId, version)}
        />
      )}
      {state === 'approved' && (
        <CommandButton
          label="Activate"
          requiredRole="approver"
          confirmMessage="Activate this plan for execution?"
          action={() => activatePlanAction(planId, projectId, version)}
        />
      )}
      <CommandButton
        label="Export plan.md"
        requiredRole="operator"
        action={() => exportPlanAction(planId, projectId)}
      />
      <CommandButton
        label="Export backlog.md"
        requiredRole="operator"
        action={() => exportBacklogAction(planId, projectId)}
      />
    </div>
  );
}
