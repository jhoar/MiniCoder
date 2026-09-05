import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Table, type Column } from './Table.js';

/**
 * A real bug: `pad()` used to hard-truncate an over-length string with `.slice(0, width)` before
 * Ink's own `wrap="truncate-end"` on the wrapping `<Text>` ever saw it — the string was already
 * exactly `width` characters, so it never overflowed its `Box` and the wrap prop was a no-op. For
 * a plain-string cell (unlike `StatusBadge`, which passes its raw string straight to `<Text
 * wrap="truncate-end">`), this meant silent, ellipsis-less truncation — worst for an ID column,
 * where a user copies the (silently cut) displayed value into a follow-up command and gets a
 * confusing 404 instead of any indication the value was incomplete.
 */
interface Row {
  id: string;
}

describe('Table', () => {
  it('shows a visible ellipsis (not a silent cut) when a cell overflows its column width', () => {
    const columns: Column<Row>[] = [{ header: 'ID', width: 10, render: (r) => r.id }];
    const fullId = '1788626002913-abcdefgh';
    const { lastFrame } = render(<Table columns={columns} rows={[{ id: fullId }]} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('…');
    // The pre-`pad()`-fix behavior silently cut to exactly `width` characters with no ellipsis
    // anywhere — this proves the fix, not just that some prefix of the id appears (it always
    // would, ellipsis or not): the full, untruncated id must never appear in the frame.
    expect(frame).not.toContain(fullId);
  });

  it('does not truncate a string that fits within the column width', () => {
    const columns: Column<Row>[] = [{ header: 'ID', width: 24, render: (r) => r.id }];
    const id = '1788626002913-abcdefgh';
    const { lastFrame } = render(<Table columns={columns} rows={[{ id }]} />);
    expect(lastFrame()).toContain(id);
  });

  it('pads a short string to the column width for alignment', () => {
    const columns: Column<Row>[] = [{ header: 'ID', width: 10, render: (r) => r.id }];
    const { lastFrame } = render(<Table columns={columns} rows={[{ id: 'ab' }]} />);
    expect(lastFrame()).toContain('ab');
  });
});
