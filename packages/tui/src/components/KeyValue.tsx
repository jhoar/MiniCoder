import React from 'react';
import { Box, Text } from 'ink';

export interface Field {
  label: string;
  value: React.ReactNode;
}

/** A simple label/value list for single-resource ("detail") views (status, active feature, etc.). */
export function KeyValue({ fields }: { fields: Field[] }): React.ReactElement {
  const labelWidth = Math.max(...fields.map((f) => f.label.length), 0) + 2;
  return (
    <Box flexDirection="column">
      {fields.map((field) => (
        <Box key={field.label}>
          <Box width={labelWidth}>
            <Text bold>{field.label}:</Text>
          </Box>
          {typeof field.value === 'string' ? <Text>{field.value}</Text> : field.value}
        </Box>
      ))}
    </Box>
  );
}
