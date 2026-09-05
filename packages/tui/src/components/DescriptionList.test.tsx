import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { DescriptionList } from './DescriptionList.js';

describe('DescriptionList', () => {
  it('renders the full text of a long item, not truncated', () => {
    const longText =
      'No deployment, packaging, installer, or auto-update mechanism defined for how end users obtain application updates.';
    const { lastFrame } = render(
      <DescriptionList items={[{ label: <Text>non_blocking</Text>, text: longText }]} />,
    );
    // Long text word-wraps across lines at the terminal width rather than truncating — that's
    // the whole point of this component — so compare with wrapped newlines collapsed rather than
    // asserting the text appears as one unbroken line.
    const normalizedFrame = (lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(normalizedFrame).toContain(longText);
    expect(normalizedFrame).not.toContain('…');
  });

  it('renders "(none)" for an empty list', () => {
    const { lastFrame } = render(<DescriptionList items={[]} />);
    expect(lastFrame()).toContain('(none)');
  });

  it('renders each item label and text', () => {
    const { lastFrame } = render(
      <DescriptionList
        items={[
          { label: <Text>high</Text>, text: 'First assumption' },
          { label: <Text>low</Text>, text: 'Second assumption' },
        ]}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('high');
    expect(frame).toContain('First assumption');
    expect(frame).toContain('low');
    expect(frame).toContain('Second assumption');
  });
});
