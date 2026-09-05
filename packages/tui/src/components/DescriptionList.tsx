import React from 'react';
import { Box, Text } from 'ink';

export interface DescriptionListItem {
  label: React.ReactNode;
  text: string;
}

/**
 * A wrapped-text list for free-form prose content (gap/assumption/question descriptions) — unlike
 * `Table`'s fixed-width truncated columns, which are the right shape for tabular/state data (a
 * short, fixed-vocabulary token like a status or severity) but the wrong one for human-authored
 * text a user actually needs to read in full. Each item's text wraps to the terminal's own width
 * (Ink's `wrap="wrap"`, not `"truncate-end"`) instead of being cut off mid-sentence.
 */
export function DescriptionList({ items }: { items: DescriptionListItem[] }): React.ReactElement {
  if (items.length === 0) {
    return <Text dimColor>(none)</Text>;
  }
  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Box key={i} flexDirection="column" marginBottom={i < items.length - 1 ? 1 : 0}>
          <Box>{item.label}</Box>
          <Text wrap="wrap">{item.text}</Text>
        </Box>
      ))}
    </Box>
  );
}
