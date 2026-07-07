import React from 'react';
import { render } from 'ink';
import { ErrorView } from './components/ErrorView.js';

/**
 * Renders an Ink element once and exits — every Phase 14 command is a fast, one-shot fetch +
 * render (docs/05 §4 "fast developer/operator workflows"), not a persistent full-screen app.
 * A thrown error is shown via `ErrorView` and causes a non-zero exit.
 */
export async function runView(build: () => Promise<React.ReactElement>): Promise<void> {
  let element: React.ReactElement;
  try {
    element = await build();
  } catch (err) {
    const instance = render(React.createElement(ErrorView, { error: err }));
    instance.unmount();
    process.exitCode = 1;
    return;
  }
  const instance = render(element);
  instance.unmount();
}
