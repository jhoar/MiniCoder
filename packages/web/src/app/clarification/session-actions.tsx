'use client';

import { useState } from 'react';
import { CommandButton } from '../../components/command-button';
import {
  startClarificationAction,
  recordClarificationAnswerAction,
  completeClarificationAction,
} from './actions';
import type { ClarificationQuestionRow } from '@minicoder/api';

export function SessionActions({
  sessionId,
  projectId,
  status,
  version,
}: {
  sessionId: string;
  projectId: string;
  status: string;
  version: number;
}): JSX.Element {
  return (
    <div>
      {status === 'clarification_required' && (
        <CommandButton
          label="Start clarification"
          requiredRole="operator"
          action={() => startClarificationAction(sessionId, projectId, version)}
        />
      )}
      {status === 'in_progress' && (
        <CommandButton
          label="Complete clarification"
          requiredRole="operator"
          confirmMessage="Mark clarification complete? All questions should be answered first."
          action={() => completeClarificationAction(sessionId, projectId, version)}
        />
      )}
    </div>
  );
}

export function QuestionAnswerForm({
  question,
  sessionId,
  projectId,
}: {
  question: ClarificationQuestionRow;
  sessionId: string;
  projectId: string;
}): JSX.Element {
  const [answer, setAnswer] = useState('');

  if (question.answered_at) {
    return <span style={{ color: '#166534' }}>Answered</span>;
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        type="text"
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="Answer…"
        style={{ flex: 1 }}
      />
      <CommandButton
        label="Submit"
        requiredRole="operator"
        action={() =>
          recordClarificationAnswerAction(
            question.id,
            sessionId,
            projectId,
            answer,
            question.version,
          )
        }
      />
    </div>
  );
}
