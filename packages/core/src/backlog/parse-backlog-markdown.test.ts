import { describe, it, expect } from 'vitest';
import { parseBacklogMarkdown, BacklogParseError } from './parse-backlog-markdown.js';

function backlog(...sections: string[]): string {
  return ['# Feature Backlog', '', ...sections].join('\n');
}

function featureSection(frId: string, title: string, kind: string, description: string): string {
  return [`## ${frId}: ${title}`, '', `Kind: ${kind}`, '', description, ''].join('\n');
}

describe('parseBacklogMarkdown', () => {
  it('parses a single feature section', () => {
    const markdown = backlog(featureSection('FR-001', 'Add widget', 'feature', 'A widget.'));
    const result = parseBacklogMarkdown(markdown);
    expect(result).toEqual([
      {
        frId: 'FR-001',
        title: 'Add widget',
        description: 'A widget.',
        kind: 'feature',
        priority: 0,
        dependsOnFrIds: [],
      },
    ]);
  });

  it('parses multiple sections in document order, assigning priority by position', () => {
    const markdown = backlog(
      featureSection('FR-001', 'First', 'feature', 'First description.'),
      featureSection('FR-002', 'Second', 'discovery', 'Second description.'),
      featureSection('FR-003', 'Third', 'feature', 'Third description.'),
    );
    const result = parseBacklogMarkdown(markdown);
    expect(result.map((f) => f.frId)).toEqual(['FR-001', 'FR-002', 'FR-003']);
    expect(result.map((f) => f.priority)).toEqual([0, 1, 2]);
    expect(result[1]?.kind).toBe('discovery');
  });

  it('joins and trims a multi-line/multi-paragraph description', () => {
    const markdown = backlog(
      [
        '## FR-001: Multiline',
        '',
        'Kind: feature',
        '',
        'First paragraph.',
        '',
        'Second paragraph.',
        '',
      ].join('\n'),
    );
    const result = parseBacklogMarkdown(markdown);
    expect(result[0]?.description).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('always returns an empty dependsOnFrIds — the format has no section to carry dependencies', () => {
    const markdown = backlog(featureSection('FR-001', 'Add widget', 'feature', 'A widget.'));
    const result = parseBacklogMarkdown(markdown);
    expect(result[0]?.dependsOnFrIds).toEqual([]);
  });

  it('throws BacklogParseError when the top-level heading is missing', () => {
    const markdown = ['## FR-001: Add widget', '', 'Kind: feature', '', 'A widget.'].join('\n');
    expect(() => parseBacklogMarkdown(markdown)).toThrow(BacklogParseError);
    expect(() => parseBacklogMarkdown(markdown)).toThrow(/Feature Backlog/);
  });

  it('throws BacklogParseError when there are no feature sections', () => {
    const markdown = backlog();
    expect(() => parseBacklogMarkdown(markdown)).toThrow(/No feature sections/);
  });

  it('throws BacklogParseError on a duplicate feature id', () => {
    const markdown = backlog(
      featureSection('FR-001', 'First', 'feature', 'First description.'),
      featureSection('FR-001', 'Duplicate', 'feature', 'Duplicate description.'),
    );
    expect(() => parseBacklogMarkdown(markdown)).toThrow(/Duplicate feature id "FR-001"/);
  });

  it('throws BacklogParseError when a Kind: line is missing', () => {
    const markdown = backlog(
      ['## FR-001: Add widget', '', 'A widget with no Kind line.'].join('\n'),
    );
    expect(() => parseBacklogMarkdown(markdown)).toThrow(/Missing "Kind:/);
  });

  it('throws BacklogParseError when the Kind value is invalid', () => {
    const markdown = backlog(
      featureSection('FR-001', 'Add widget', 'not-a-real-kind', 'A widget.'),
    );
    expect(() => parseBacklogMarkdown(markdown)).toThrow(/Invalid Kind value/);
  });

  it('throws BacklogParseError when the description is empty', () => {
    const markdown = backlog(['## FR-001: Add widget', '', 'Kind: feature', ''].join('\n'));
    expect(() => parseBacklogMarkdown(markdown)).toThrow(/Missing description/);
  });

  it('includes a 1-based line number in the error message where available', () => {
    const markdown = backlog(
      featureSection('FR-001', 'First', 'feature', 'First description.'),
      featureSection('FR-001', 'Duplicate', 'feature', 'Duplicate description.'),
    );
    try {
      parseBacklogMarkdown(markdown);
      expect.fail('expected parseBacklogMarkdown to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BacklogParseError);
      expect((err as BacklogParseError).line).toBeGreaterThan(0);
      expect((err as Error).message).toMatch(/\(line \d+\)/);
    }
  });
});
