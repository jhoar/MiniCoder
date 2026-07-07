'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult } from '../lib/action-result';
import { useMeetsRole } from './actor-context';
import type { UserRole } from '../lib/role-rank';

/**
 * Generic wrapper for every command-issuing button in this package. Calls the bound Server Action
 * directly from a click handler (a supported Next.js pattern — Server Actions need not be
 * attached to a `<form action>` to run server-side). Renders the discriminated `ActionResult`
 * inline rather than throwing: a 403 shows "insufficient role", any other failure shows the raw
 * problem-detail message. The backend is the only real authorization check — `requiredRole` here
 * only pre-emptively hides/disables the button for the common case (see `lib/role-rank.ts`).
 *
 * Uses plain `useState` for the pending flag rather than `useTransition`. This package was
 * originally built against React 18, where `startTransition` doesn't accept an `async` callback
 * (`TransitionFunction` requires a synchronous, void-returning function) — manual state was
 * required to track the real async duration, since a fire-and-forget
 * `startTransition(async () => ...)` workaround flips `isPending` back to `false` as soon as the
 * synchronous wrapper returns, before the request actually completes. React 19 (adopted with the
 * Next 16 upgrade) does support `async` transitions natively, but the plain-`useState` approach
 * was kept as-is rather than migrated purely for its own sake — it already behaves correctly and
 * introduces no React-19-specific behavior to verify.
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
}): ReactElement | null {
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
