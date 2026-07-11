import type { ReactElement } from 'react';
const TONE_BY_KEYWORD: Array<{ pattern: RegExp; color: string; background: string }> = [
  { pattern: /fail|error|blocked|rejected|escalat/i, color: '#7f1d1d', background: '#fee2e2' },
  {
    pattern: /human_required|paused|waiting|changes_requested/i,
    color: '#78350f',
    background: '#fef3c7',
  },
  {
    pattern: /merged|approved|succeeded|ready|running|resolved/i,
    color: '#14532d',
    background: '#dcfce7',
  },
];

function toneFor(value: string): { color: string; background: string } {
  for (const entry of TONE_BY_KEYWORD) {
    if (entry.pattern.test(value)) return entry;
  }
  return { color: '#1e293b', background: '#e2e8f0' };
}

export function StatusBadge({ value }: { value: string }): ReactElement {
  const tone = toneFor(value);
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: '0.8rem',
        fontWeight: 600,
        color: tone.color,
        background: tone.background,
        whiteSpace: 'nowrap',
      }}
    >
      {value}
    </span>
  );
}
