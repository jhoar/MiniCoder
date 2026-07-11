import type { ReactNode, ReactElement } from 'react';

export function KeyValue({
  entries,
}: {
  entries: Array<{ label: string; value: ReactNode }>;
}): ReactElement {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px' }}>
      {entries.map((entry) => (
        <div key={entry.label} style={{ display: 'contents' }}>
          <dt style={{ color: '#64748b', fontWeight: 600 }}>{entry.label}</dt>
          <dd style={{ margin: 0 }}>{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}
