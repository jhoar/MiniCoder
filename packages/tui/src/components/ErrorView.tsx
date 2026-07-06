import React from 'react';
import { Box, Text } from 'ink';
import { ApiError } from '../client/api-client.js';

/** Renders a caught `ApiError`/generic error — `runView()` exits non-zero after showing this. */
export function ErrorView({ error }: { error: unknown }): React.ReactElement {
  if (error instanceof ApiError) {
    return (
      <Box flexDirection="column">
        <Text color="red">
          Error {error.status} ({error.problem.type}): {error.problem.title}
        </Text>
        <Text>{error.problem.detail}</Text>
      </Box>
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return <Text color="red">Error: {message}</Text>;
}
