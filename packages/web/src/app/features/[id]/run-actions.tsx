'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import { CommandButton } from '../../../components/command-button';
import {
  selectFeatureAction,
  resumeFeatureExecutionAction,
  retryFeatureAction,
  skipFeatureAction,
  blockFeatureAction,
  resolveDisagreementAction,
  requestCoderRunAction,
  requestReviewAction,
  requestFixesAction,
  recomputeMergeGateAction,
  mergeIfReadyAction,
  finalizeIfGithubMergedAction,
} from './actions';

export function RunActions({
  featureId,
  featureRunId,
  projectId,
  state,
  version,
}: {
  featureId: string;
  featureRunId: string;
  projectId: string;
  state: string;
  version: number;
}): ReactElement {
  const [notes, setNotes] = useState('');
  const [coderAdapterName, setCoderAdapterName] = useState('CodexCoderAdapter');
  const [reviewerAdapterName, setReviewerAdapterName] = useState('ClaudeReviewerAdapter');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        {state === 'approved_pending_execution' && (
          <CommandButton
            label="Select feature"
            requiredRole="operator"
            action={() => selectFeatureAction(featureId, featureRunId, projectId, version)}
          />
        )}
        {(state === 'coding' || state === 'fixing') && (
          <CommandButton
            label="Request coder run"
            requiredRole="operator"
            action={() =>
              requestCoderRunAction(featureId, featureRunId, projectId, coderAdapterName)
            }
          />
        )}
        {state === 'ci_running' || state === 'under_review' ? (
          <CommandButton
            label="Request review"
            requiredRole="operator"
            action={() =>
              requestReviewAction(featureId, featureRunId, projectId, reviewerAdapterName)
            }
          />
        ) : null}
        {state === 'changes_requested' && (
          <CommandButton
            label="Request fixes"
            requiredRole="operator"
            action={() =>
              requestFixesAction(featureId, featureRunId, projectId, reviewerAdapterName)
            }
          />
        )}
        {state === 'under_review' && (
          <CommandButton
            label="Recompute merge gate"
            requiredRole="operator"
            action={() => recomputeMergeGateAction(featureId, featureRunId, projectId)}
          />
        )}
        {state === 'approved_by_policy' && (
          <CommandButton
            label="Merge if ready"
            requiredRole="approver"
            confirmMessage="Merge this pull request now?"
            action={() => mergeIfReadyAction(featureId, featureRunId, projectId)}
          />
        )}
        {state === 'merge_ready' && (
          <CommandButton
            label="Finalize if GitHub merged"
            requiredRole="operator"
            action={() => finalizeIfGithubMergedAction(featureId, featureRunId, projectId)}
          />
        )}
      </div>

      {state === 'human_required' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 480 }}>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes / resolution (required)"
            rows={2}
          />
          <div>
            <CommandButton
              label="Resume execution"
              requiredRole="approver"
              action={() =>
                resumeFeatureExecutionAction(featureId, featureRunId, projectId, version, notes)
              }
            />
            <CommandButton
              label="Resolve disagreement"
              requiredRole="approver"
              action={() =>
                resolveDisagreementAction(featureId, featureRunId, projectId, version, notes)
              }
            />
            <CommandButton
              label="Retry"
              requiredRole="approver"
              action={() => retryFeatureAction(featureId, featureRunId, projectId, version, notes)}
            />
            <CommandButton
              label="Skip"
              requiredRole="approver"
              confirmMessage="Skip this feature permanently?"
              action={() => skipFeatureAction(featureId, featureRunId, projectId, version, notes)}
            />
            <CommandButton
              label="Block"
              requiredRole="approver"
              action={() => blockFeatureAction(featureId, featureRunId, projectId, version, notes)}
            />
          </div>
        </div>
      )}

      <details>
        <summary>Adapter names (for request-coder-run / request-review / request-fixes)</summary>
        <label>
          Coder adapter:{' '}
          <input value={coderAdapterName} onChange={(e) => setCoderAdapterName(e.target.value)} />
        </label>
        <br />
        <label>
          Reviewer adapter:{' '}
          <input
            value={reviewerAdapterName}
            onChange={(e) => setReviewerAdapterName(e.target.value)}
          />
        </label>
      </details>
    </div>
  );
}
