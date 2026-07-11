'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import { CommandButton } from '../../components/command-button';
import { approveBudgetOverrideAction } from './actions';

export function OverrideForm({
  projectId,
  workflowVersion,
  budgetPolicyId,
}: {
  projectId: string;
  workflowVersion: number;
  budgetPolicyId: string;
}): ReactElement {
  const [reason, setReason] = useState('');

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Override reason (required)"
        style={{ minWidth: 220 }}
      />
      <CommandButton
        label="Approve override"
        requiredRole="approver"
        confirmMessage="Approve a budget override for this project?"
        action={() =>
          approveBudgetOverrideAction(projectId, workflowVersion, reason, budgetPolicyId)
        }
      />
    </div>
  );
}
