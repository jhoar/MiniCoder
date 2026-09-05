import React from 'react';
import { Box, Text } from 'ink';

export interface Column<T> {
  header: string;
  width: number;
  render: (row: T) => React.ReactNode;
}

/**
 * Pads a short string to `width` for column alignment. Deliberately does NOT truncate an
 * over-length string itself — the previous `.slice(0, width)` here silently hard-cut content
 * with no ellipsis, before Ink's own `wrap="truncate-end"` on the wrapping `<Text>` ever got a
 * chance to run (the string was already exactly `width` characters by the time Ink saw it, so it
 * never overflowed its `Box` and the wrap prop was a no-op). `StatusBadge` never had this problem
 * — it passes its raw string straight to `<Text wrap="truncate-end">` with no pre-slice, so Ink
 * truncates it WITH a visible "…". Passing the untruncated string through here lets Ink do the
 * identical thing for plain-string cells. This was a real bug for ID columns specifically: an
 * opaque id copied out of a truncated cell (with no visual indication it was cut) silently failed
 * every follow-up command that took it as an argument.
 */
function pad(text: string, width: number): string {
  if (text.length >= width) return text;
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
