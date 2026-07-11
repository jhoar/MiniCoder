import type { ReactElement } from 'react';

const LINKS: Array<{ href: string; label: string }> = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/planning', label: 'Planning' },
  { href: '/clarification', label: 'Clarification' },
  { href: '/features', label: 'Features' },
  { href: '/agent-runs', label: 'Agent Runs' },
  { href: '/findings', label: 'Findings' },
  { href: '/disagreements', label: 'Disagreements' },
  { href: '/costs', label: 'Costs' },
  { href: '/budgets', label: 'Budgets' },
  { href: '/artifacts', label: 'Artifacts' },
  { href: '/adapters', label: 'Adapters' },
  { href: '/design-document', label: 'Design Document' },
  { href: '/human-required', label: 'Human Required' },
  { href: '/state-health', label: 'State Health' },
  { href: '/settings', label: 'Settings' },
];

export function Nav(): ReactElement {
  return (
    <nav
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        padding: '10px 16px',
        borderBottom: '1px solid #e2e8f0',
        fontSize: '0.9rem',
      }}
    >
      {LINKS.map((link) => (
        // Plain `<a>` rather than `next/link`'s `Link` — sidesteps a confirmed Next 16 /
        // @types/react typing incompatibility (`Link` fails the JSX-component-validity check;
        // see CLAUDE.md's Next.js Web UI Operational Constraints). Every other internal link in
        // this package already uses a plain `<a>` for the same reason this is an acceptable
        // trade-off here: an ops dashboard nav bar has no meaningful need for client-side
        // transitions over a full navigation.
        <a key={link.href} href={link.href} style={{ color: '#334155' }}>
          {link.label}
        </a>
      ))}
    </nav>
  );
}
