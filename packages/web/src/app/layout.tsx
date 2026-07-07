import type { ReactElement, ReactNode } from 'react';
import { getApiClient } from '../lib/api-server';
import { ActorProvider } from '../components/actor-context';
import { Nav } from '../components/nav';

export const metadata = {
  title: 'MiniCoder',
};

// Every page reads live orchestration state via `cache: 'no-store'` fetches — never statically
// cached/prerendered.
export const dynamic = 'force-dynamic';

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactElement> {
  const client = getApiClient();
  const actor = await client.getWhoami();

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', color: '#0f172a' }}>
        <ActorProvider actor={actor}>
          <header
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 16px',
              borderBottom: '1px solid #e2e8f0',
            }}
          >
            <strong>MiniCoder</strong>
            <span style={{ fontSize: '0.85rem', color: '#64748b' }}>
              {actor.displayName ?? actor.id} · {actor.role} ({actor.actorKind})
            </span>
          </header>
          <Nav />
          <main style={{ padding: '16px 24px' }}>{children}</main>
        </ActorProvider>
      </body>
    </html>
  );
}
