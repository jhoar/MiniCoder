'use client';

import type { ReactElement } from 'react';
import { CommandButton } from '../../components/command-button';
import { generateDesignDocumentAction, regenerateDesignDocumentAction } from './actions';

export function GenerateDesignDocumentActions({
  projectId,
  projectState,
  projectVersion,
}: {
  projectId: string;
  projectState: string;
  projectVersion: number;
}): ReactElement | null {
  if (projectState === 'implementation_complete') {
    return (
      <CommandButton
        label="Generate design document"
        requiredRole="operator"
        confirmMessage="Start generating the final design document?"
        action={() => generateDesignDocumentAction(projectId, projectVersion)}
      />
    );
  }
  if (projectState === 'design_document_revision_requested') {
    return (
      <CommandButton
        label="Regenerate design document"
        requiredRole="operator"
        confirmMessage="Start regenerating the final design document?"
        action={() => regenerateDesignDocumentAction(projectId, projectVersion)}
      />
    );
  }
  return null;
}
