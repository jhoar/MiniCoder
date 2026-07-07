'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult } from '../lib/action-result';
import { useMeetsRole } from './actor-context';
import type { UserRole } from '../lib/role-rank';

/**
 * Generic wrapper for every command-issuing button in this package. Calls the bound Server Action
 * directly from a click handler (a supported Next.js 14 pattern — Server Actions need not be
 * attached to a `<form action>` to run server-side). Renders the discriminated `ActionResult`
 * inline rather than throwing: a 403 shows "insufficient role", any other failure shows the raw
 * problem-detail message. The backend is the only real authorization check — `requiredRole` here
 * only pre-emptively hides/disables the button for the common case (see `lib/role-rank.ts`).
 *
 * Uses plain `useState` for the pending flag rather than `useTransition` — React 18's
 * `TransitionFunction` type requires a synchronous, void-returning callback, so an `async`
 * callback doesn't type-check with `startTransition` (this only became a first-class pattern in
 * React 19). Manual state tracks the real async duration precisely, where a fire-and-forget
 * `startTransition(async () => ...)` workaround would flip `isPending` back to `false` as soon as
 * the synchronous wrapper returns, before the request actually completes.
 */
export function CommandButton({
  label,
  pendingLabel,
  action,
  requiredRole,
  confirmMessage,
  onSuccess,
}: {
  label: string;
  pendingLabel?: string;
  action: () => Promise<ActionResult<unknown>>;
  requiredRole?: UserRole;
  confirmMessage?: string;
  onSuccess?: (data: unknown) => void;
}): JSX.Element | null {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const router = useRouter();
  // Hooks must run unconditionally — 'viewer' is rank 0, so every actor "meets" it when no
  // requiredRole was supplied, making this check a no-op in that case.
  const allowed = useMeetsRole(requiredRole ?? 'viewer');

  if (!allowed) return null;

  const handleClick = async (): Promise<void> => {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setMessage(null);
    setPending(true);
    try {
      const result = await action();
      if (result.ok) {
        setMessage({ tone: 'success', text: 'Done.' });
        onSuccess?.(result.data);
        router.refresh();
      } else if (result.kind === 'forbidden') {
        setMessage({
          tone: 'error',
          text: `Insufficient role for this action (requires ${requiredRole ?? 'a higher role'}).`,
        });
      } else {
        setMessage({ tone: 'error', text: result.detail });
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={{ display: 'inline-block' }}>
      <button onClick={() => void handleClick()} disabled={pending} style={{ marginRight: 8 }}>
        {pending ? (pendingLabel ?? 'Working…') : label}
      </button>
      {message && (
        <span
          style={{ color: message.tone === 'error' ? '#b91c1c' : '#166534', fontSize: '0.85rem' }}
        >
          {message.text}
        </span>
      )}
    </div>
  );
}
