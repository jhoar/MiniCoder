import type {
  DocumentationAgentAdapter,
  DocumentationBehavior,
  DocumentationInput,
  DocumentationOutput,
  AdapterCall,
} from './types.js';

const SECTION_NAMES = [
  'Purpose and Scope',
  'Goals and Constraints',
  'System Context',
  'Architecture Overview',
  'Component Design',
  'Data Design',
  'API and Interface Design',
  'Workflows and Runtime Behavior',
  'Deployment and Infrastructure',
  'Observability and Operations',
  'Testing Strategy',
  'Design Decisions',
  'Glossary',
];

export class MockDocumentationAdapter implements DocumentationAgentAdapter {
  readonly role = 'DocumentationAgentAdapter' as const;
  readonly calls: AdapterCall<DocumentationInput, DocumentationOutput>[] = [];

  constructor(public behavior: DocumentationBehavior = 'succeed') {}

  async run(input: DocumentationInput): Promise<DocumentationOutput> {
    const output: DocumentationOutput = {
      documentId: `mock-doc-${input.projectId}-${Date.now()}`,
      sections: SECTION_NAMES.map((sectionName) => ({
        sectionName,
        content: `MockDocumentationAdapter: ${sectionName} content for project ${input.projectId}`,
      })),
      requiresRevision: this.behavior === 'require_revision',
    };

    this.calls.push({ input, output, calledAt: new Date().toISOString() });
    return output;
  }
}
