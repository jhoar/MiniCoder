'use client';

import type { ReactElement } from 'react';
import { CommandButton } from '../../components/command-button';
import { requestDesignDocumentRevisionAction, approveDesignDocumentAction } from './actions';

export function DesignDocumentActions({
  projectId,
  projectVersion,
  designDocumentId,
}: {
  projectId: string;
  projectVersion: number;
  designDocumentId: string;
}): ReactElement {
  return (
    <div style={{ marginBottom: 8 }}>
      <CommandButton
        label="Request revision"
        requiredRole="approver"
        confirmMessage="Request a revision of this design document?"
        action={() =>
          requestDesignDocumentRevisionAction(
            projectId,
            projectVersion,
            designDocumentId,
            undefined,
          )
        }
      />{' '}
      <CommandButton
        label="Approve"
        requiredRole="approver"
        confirmMessage="Approve this design document? This moves the project toward project_complete."
        action={() =>
          approveDesignDocumentAction(projectId, projectVersion, designDocumentId, undefined)
        }
      />
    </div>
  );
}
