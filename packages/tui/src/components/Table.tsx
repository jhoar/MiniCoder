import React from 'react';
import { Box, Text } from 'ink';

export interface Column<T> {
  header: string;
  width: number;
  render: (row: T) => React.ReactNode;
}

function pad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + ' '.repeat(width - text.length);
}

/**
 * A minimal hand-rolled fixed-width table over Ink `Box`/`Text` primitives — deliberately not a
 * dependency on `ink-table` (or any other Ink ecosystem package) to avoid a second possibly-ESM-
 * only dependency beyond the already-pinned `ink@3.2.0`/`react@17.0.2` (see CLAUDE.md's Ink Text
 * UI Operational Constraints).
 */
export function Table<T>({
  columns,
  rows,
}: {
  columns: Column<T>[];
  rows: T[];
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        {columns.map((col) => (
          <Box key={col.header} width={col.width + 1} flexShrink={0}>
            <Text bold underline wrap="truncate-end">
              {pad(col.header, col.width)}
            </Text>
          </Box>
        ))}
      </Box>
      {rows.length === 0 ? (
        <Text dimColor>(none)</Text>
      ) : (
        rows.map((row, i) => (
          <Box key={i}>
            {columns.map((col) => {
              const cell = col.render(row);
              return (
                <Box key={col.header} width={col.width + 1} flexShrink={0}>
                  {typeof cell === 'string' ? (
                    <Text wrap="truncate-end">{pad(cell, col.width)}</Text>
                  ) : (
                    cell
                  )}
                </Box>
              );
            })}
          </Box>
        ))
      )}
    </Box>
  );
}
