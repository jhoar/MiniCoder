'use client';

import type { ReactElement } from 'react';
import { createContext, createElement, useContext, type ReactNode } from 'react';
import { meetsRole, type UserRole } from '../lib/role-rank';

export interface ActorInfo {
  id: string;
  role: string;
  actorKind: 'human' | 'system';
  displayName?: string;
}

const ActorContext = createContext<ActorInfo | null>(null);

/** Wraps the already-server-fetched `/whoami` result so nested Client Components can read the
 * caller's own role/actorKind without re-fetching. Performs no fetch of its own — see
 * `app/layout.tsx`, which is the only place `getApiClient().getWhoami()` is called. */
export function ActorProvider({
  actor,
  children,
}: {
  actor: ActorInfo;
  children: ReactNode;
}): ReactElement {
  // `createElement` rather than `<ActorContext.Provider>` JSX syntax — a known @types/react 18.x
  // strictness quirk rejects `Context.Provider` as a JSX tag ("its return type 'ReactNode' is not
  // a valid JSX element") because the Provider's declared signature returns the broader
  // `ReactNode` rather than `Element | null`. `createElement` isn't subject to the same JSX-tag
  // validity check, so it sidesteps the false positive without any behavior change.
  return createElement(ActorContext.Provider, { value: actor }, children);
}

export function useActor(): ActorInfo {
  const actor = useContext(ActorContext);
  if (!actor) {
    throw new Error('useActor() called outside an ActorProvider — check app/layout.tsx.');
  }
  return actor;
}

/** UX-only pre-emptive check — see `lib/role-rank.ts`. The backend is the real enforcement point;
 * this only decides whether to render a button at all. */
export function useMeetsRole(requiredRole: UserRole): boolean {
  const actor = useActor();
  return meetsRole(actor.role, requiredRole);
}
