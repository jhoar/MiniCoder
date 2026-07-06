/**
 * Issue #33: parses `backlog.md`-format Markdown (the exact format `ExportBacklogHandler`
 * generates) back into structured features suitable for `ImportBacklogPayload.features`.
 *
 * This is a pure function with no DB access — parsing happens strictly upstream of
 * `ImportBacklogCommand` (docs/02 §11: parse -> validate -> preview -> approve -> transactional
 * import), consistent with CLAUDE.md's "Markdown artifacts are never runtime state": this module
 * converts a Markdown *snapshot* into the same structured shape a caller could have hand-built,
 * it never becomes a runtime source of truth itself.
 *
 * **Format constraint (docs/02 §11):** `ExportBacklogHandler`'s Markdown format carries only
 * `fr_id`, `title`, `kind`, and `description` — it does not emit `priority` or dependency edges.
 * A round trip through export -> parse -> import therefore reconstructs `priority` from each
 * feature's position in the document (0-based, matching the `ORDER BY priority ASC, fr_id ASC`
 * the export query already used) rather than the original numeric priority value, and always
 * produces an empty `dependsOnFrIds` — the format has no section to carry dependencies in. This
 * is a real, documented limitation of the current format, not a parser bug.
 */

export class BacklogParseError extends Error {
  constructor(
    message: string,
    public readonly line?: number,
  ) {
    super(line !== undefined ? `${message} (line ${line})` : message);
    this.name = 'BacklogParseError';
  }
}

export interface ParsedBacklogFeature {
  readonly frId: string;
  readonly title: string;
  readonly description: string;
  readonly kind: 'feature' | 'discovery';
  readonly priority: number;
  readonly dependsOnFrIds: string[];
}

const TITLE_HEADING_RE = /^# Feature Backlog\s*$/;
const FEATURE_HEADING_RE = /^## (FR-\d+): (.+?)\s*$/;
const KIND_LINE_RE = /^Kind: (feature|discovery)\s*$/;

interface RawSection {
  frId: string;
  title: string;
  headingLine: number;
  bodyLines: string[];
  bodyStartLine: number;
}

/**
 * Parses `markdown` (a `backlog.md` snapshot) into an ordered list of features. Throws
 * `BacklogParseError` with a 1-based line number on any structural problem — a missing top-level
 * heading, no feature sections at all, a duplicate `fr_id`, a missing/invalid `Kind:` line, or an
 * empty description — so a malformed file fails fast with an actionable message rather than
 * silently importing a partial/incorrect backlog.
 */
export function parseBacklogMarkdown(markdown: string): ParsedBacklogFeature[] {
  const lines = markdown.split(/\r?\n/);

  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (i >= lines.length || !TITLE_HEADING_RE.test(lines[i]!)) {
    throw new BacklogParseError(
      'Expected the backlog markdown to start with a "# Feature Backlog" heading',
      i + 1,
    );
  }
  i++;

  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const headingMatch = FEATURE_HEADING_RE.exec(line);
    if (headingMatch) {
      if (current) sections.push(current);
      current = {
        frId: headingMatch[1]!,
        title: headingMatch[2]!,
        headingLine: i + 1,
        bodyLines: [],
        bodyStartLine: i + 2,
      };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  if (current) sections.push(current);

  if (sections.length === 0) {
    throw new BacklogParseError(
      'No feature sections ("## FR-<n>: <title>") found in backlog markdown',
    );
  }

  const seenFrIds = new Set<string>();
  return sections.map((section, index) => {
    if (seenFrIds.has(section.frId)) {
      throw new BacklogParseError(`Duplicate feature id "${section.frId}"`, section.headingLine);
    }
    seenFrIds.add(section.frId);

    const kindLineIndex = section.bodyLines.findIndex((l) => l.trim().startsWith('Kind:'));
    if (kindLineIndex === -1) {
      throw new BacklogParseError(
        `Missing "Kind: <feature|discovery>" line for ${section.frId}`,
        section.headingLine,
      );
    }
    const kindMatch = KIND_LINE_RE.exec(section.bodyLines[kindLineIndex]!.trim());
    if (!kindMatch) {
      throw new BacklogParseError(
        `Invalid Kind value for ${section.frId} — expected "Kind: feature" or "Kind: discovery"`,
        section.bodyStartLine + kindLineIndex,
      );
    }

    const description = section.bodyLines
      .slice(kindLineIndex + 1)
      .join('\n')
      .trim();
    if (description.length === 0) {
      throw new BacklogParseError(`Missing description for ${section.frId}`, section.headingLine);
    }

    return {
      frId: section.frId,
      title: section.title,
      description,
      kind: kindMatch[1] as 'feature' | 'discovery',
      priority: index,
      dependsOnFrIds: [],
    };
  });
}
