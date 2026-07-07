'use client';

import { CommandButton } from '../../components/command-button';
import { reconcileAction } from './actions';

export function ReconcileButton({ projectId }: { projectId: string }): JSX.Element {
  return (
    <div>
      <CommandButton
        label="Reconcile this project"
        requiredRole="operator"
        confirmMessage="Clear stale workflow locks for this project?"
        action={() => reconcileAction(projectId, false)}
      />
      <CommandButton
        label="Reconcile globally (clears stuck queues too)"
        requiredRole="operator"
        confirmMessage="Clear stale locks AND mark stuck outbox/inbox events failed, globally?"
        action={() => reconcileAction(undefined, true)}
      />
    </div>
  );
}
