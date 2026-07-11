import type { ReactElement } from 'react';
import { getApiClient } from '../lib/api-server';
import { ActorProvider } from '../components/actor-context';
import { Nav } from '../components/nav';

export const metadata = {
  title: 'MiniCoder',
};

// Every page reads live orchestration state via `cache: 'no-store'` fetches — never statically
// cached/prerendered.
export const dynamic = 'force-dynamic';

// `children` is typed `any` here as a narrow, confirmed workaround, not an oversight. Both a
// hand-rolled `{ children: ReactNode }` prop type AND Next 16's own generated `LayoutProps<'/'>`
// helper (see `next typegen`) fail the same way: TypeScript reports the ambient-global
// `React.ReactNode` used internally by Next's generated `LayoutConfig<'/'>`/`LayoutProps<'/'>`
// checks as not assignable to the module-scoped `ReactNode` this file would otherwise import from
// 'react' — "Type '{}' is not assignable to type 'ReactNode'" — reproduced against a truly clean
// `pnpm install --frozen-lockfile` (not a local caching artifact), and reproduced whether the
// error surfaces at the prop-type-declaration site or at the `{children}` JSX-rendering site.
// Scoped to this one binding in this one file.
export default async function RootLayout({ children }: { children: any }): Promise<ReactElement> {
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
