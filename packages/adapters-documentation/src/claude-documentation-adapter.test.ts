import { describe, it, expect } from 'vitest';
import { DESIGN_DOCUMENT_SECTION_NAMES, type DocumentationInput } from '@minicoder/core';
import { ClaudeDocumentationAdapter } from './claude-documentation-adapter.js';
import type { DocumentationProvider, DocumentationResult } from './documentation-provider.js';

function fakeProvider(result: DocumentationResult): DocumentationProvider {
  return {
    async draft() {
      return result;
    },
  };
}

function baseInput(): DocumentationInput {
  return { projectId: 'proj-1', planId: 'plan-1', featureCount: 3, correlationId: 'corr-1' };
}

function baseOptions() {
  return {
    projectName: 'Demo',
    projectDescription: null,
    featureSummaries: [],
    mergedPullRequestCount: 0,
  };
}

describe('ClaudeDocumentationAdapter', () => {
  it('reports requiresRevision: false when every section is present and nonblank', async () => {
    const provider = fakeProvider({
      sections: DESIGN_DOCUMENT_SECTION_NAMES.map((sectionName) => ({
        sectionName,
        content: `content for ${sectionName}`,
      })),
    });
    const adapter = new ClaudeDocumentationAdapter({
      documentationProvider: provider,
      ...baseOptions(),
    });

    const output = await adapter.run(baseInput());

    expect(output.requiresRevision).toBe(false);
    expect(output.sections).toHaveLength(DESIGN_DOCUMENT_SECTION_NAMES.length);
  });

  it('flags requiresRevision: true when the raw provider output omits a required section, even though the returned sections array is padded with a placeholder', async () => {
    const [, ...withoutFirst] = DESIGN_DOCUMENT_SECTION_NAMES;
    const provider = fakeProvider({
      sections: withoutFirst.map((sectionName) => ({
        sectionName,
        content: `content for ${sectionName}`,
      })),
    });
    const adapter = new ClaudeDocumentationAdapter({
      documentationProvider: provider,
      ...baseOptions(),
    });

    const output = await adapter.run(baseInput());

    expect(output.requiresRevision).toBe(true);
    // Still returns all 13 sections (padded), so downstream code always has a full row set to
    // write for operator visibility — the caller decides what to do with requiresRevision.
    expect(output.sections).toHaveLength(DESIGN_DOCUMENT_SECTION_NAMES.length);
    expect(
      output.sections.find((s) => s.sectionName === DESIGN_DOCUMENT_SECTION_NAMES[0])?.content,
    ).toContain('no content drafted');
  });

  it('flags requiresRevision: true when a returned section has blank content', async () => {
    const provider = fakeProvider({
      sections: DESIGN_DOCUMENT_SECTION_NAMES.map((sectionName) => ({
        sectionName,
        content: sectionName === 'Glossary' ? '   ' : `content for ${sectionName}`,
      })),
    });
    const adapter = new ClaudeDocumentationAdapter({
      documentationProvider: provider,
      ...baseOptions(),
    });

    const output = await adapter.run(baseInput());

    expect(output.requiresRevision).toBe(true);
  });
});
