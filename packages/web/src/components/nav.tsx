import type { ReactElement } from 'react';
import Link from 'next/link';

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
        <Link key={link.href} href={link.href} style={{ color: '#334155' }}>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
