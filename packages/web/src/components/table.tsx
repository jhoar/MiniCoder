import type { ReactNode, ReactElement } from 'react';

export interface Column<T> {
  header: string;
  render: (row: T) => ReactNode;
  key: string;
}

export function Table<T>({
  columns,
  rows,
  emptyLabel = 'No rows.',
  rowKey,
}: {
  // `NoInfer` pins T's inference to `rows` alone — without it, TS tries (and fails, landing on
  // `unknown`) to jointly infer T from `rows`, `columns`, and `rowKey` all at once, since all
  // three reference T in the same object literal argument.
  columns: Column<NoInfer<T>>[];
  rows: T[];
  emptyLabel?: string;
  rowKey: (row: NoInfer<T>) => string;
}): ReactElement {
  if (rows.length === 0) {
    return <p style={{ color: '#64748b' }}>{emptyLabel}</p>;
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{
                  textAlign: 'left',
                  borderBottom: '1px solid #cbd5e1',
                  padding: '6px 10px',
                  whiteSpace: 'nowrap',
                }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((col) => (
                <td
                  key={col.key}
                  style={{ borderBottom: '1px solid #e2e8f0', padding: '6px 10px' }}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
