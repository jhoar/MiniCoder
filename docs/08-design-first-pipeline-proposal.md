# MiniCoder — Design-First Pipeline Proposal

> Status: Proposed (not yet adopted — implementation not started)
> Supersedes: none. Does not modify `06-implementation-plan.md`'s single canonical 18-phase list;
> this proposal is a candidate future phase (or phase-insertion) pending a decision to implement.
> Version: 0.1.0
> Last-updated: 2026-09-07

Terms and state names referenced here are defined in
[`00-glossary-and-terms.md`](00-glossary-and-terms.md). None of the new tokens introduced by this
proposal (§4) are canonical yet — per CLAUDE.md's own rule, they must be added to the glossary
*before* any code uses them, which happens at implementation time, not in this proposal.

## 1. Problem statement

MiniCoder currently derives the feature backlog directly from the ingested specification
(`docs/02-bootstrap-planner-clarification.md` §5):

```
ingest specification → readiness assessment → clarification
    → generate implementation plan → generate feature requests → validate backlog
    → approve → activate → execute features → ... → (Phase 17) generate final design document
```

Each feature request is decomposed from the specification independently by the planner adapter.
There is no explicit, shared architectural artifact produced *before* decomposition — no agreed
module boundaries, interface contracts, naming conventions, or data model — for the planner to
decompose *against*, and no such artifact for the Coder/Reviewer adapters to ground each
feature's implementation in later. The `packages/core/src/design-doc/` machinery that does
produce such an artifact (`design_documents`, `design_document_sections`, `design_decisions`)
only runs once, at the very end (Phase 17), built from evidence of what was *already* merged. It
is a report, not an input.

This creates a specific, observed-in-practice failure mode for LLM-driven decomposition and
implementation: two features drafted from the same specification, months apart in
implementation-wall-clock terms (or even in the same backlog-generation call), can each invent
their own name for the same concept, disagree on a module boundary, or duplicate a data model —
because neither the planner nor either feature's Coder/Reviewer invocation had a shared, explicit
reference to check against. Nothing catches this until a human reviewer notices it in a PR, if at
all. This is a well-known drift risk for LLM coding: implicit design knowledge that exists only in
the specification's prose, or in an earlier feature's already-merged code, does not reliably
propagate to a later, independently-invoked agent call.

**Goal of this proposal:** produce an explicit design artifact *before* backlog decomposition and
keep it available as durable, shared grounding context for every feature's implementation — not
primarily as a gate that blocks backlog generation, but as the anti-drift mechanism itself.

## 2. Design principle: grounding, not gatekeeping

Two different mechanisms could address "the backlog/features should be coherent with the design
document":

- **Soft coherence (grounding):** the design doc is given to the planner adapter when drafting
  the backlog, and to the Coder/Reviewer adapters on every single feature invocation, as durable
  context. Nothing mechanically blocks divergence; the doc just makes implicit structure explicit
  and available at every decision point.
- **Hard coherence (gatekeeping):** a structural or LLM-based check blocks backlog validation (or
  even individual PRs) if a feature doesn't map to a declared design-doc component, and re-fires
  if the design doc changes after a feature has already started executing.

This proposal recommends **soft coherence as the primary mechanism** (§5), because it is what
directly addresses the drift risk described in §1: giving every feature's Coder/Reviewer call the
*same* explicit reference is what keeps independently-invoked agent runs consistent with each
other, regardless of whether a downstream gate ever fires. Hard coherence is address as optional
future work (§8) because it introduces a much larger set of open questions (see §8) without being
the thing that actually prevents the drift this proposal is written to solve.

## 3. Proposed pipeline shape

```
ingest specification
    ↓
readiness assessment
    ↓
clarification (existing, unchanged)
    ↓
generate preliminary design document              ← NEW
    ↓
LLM-based design review (+ human approval gate)   ← NEW
    ↓
generate implementation plan / feature backlog     ← now design-doc-grounded
    ↓
validate backlog
    ↓
approve → activate
    ↓
execute features (coder / review / merge)          ← now design-doc-grounded, per feature
    ↓
implementation_complete
    ↓
final design document reconciliation                ← existing Phase 17 machinery, repurposed
    (reconciles the preliminary doc against what actually shipped, not first authorship)
    ↓
project_complete
```

The existing Phase 17 "Final Design Document Generator" is not discarded. It is repurposed: today
it authors the design document from scratch, from merged-PR evidence, at the end. Under this
proposal the document already exists (as the preliminary doc, approved before execution); the
end-of-project pass becomes a **reconciliation** pass — it re-runs evidence collection
(`collectDesignDocumentEvidence()`) against what actually merged (including features that were
`skipped`, dependencies that changed, disagreements resolved differently than planned) and
produces a diff against the preliminary doc for human approval, rather than drafting from a blank
page. This reuses nearly all of the existing Phase 17 machinery (`DocumentationAgentAdapter`,
`design_document_sections`, the review/approval state machine) — the new work is earlier in the
pipeline, not a replacement of what exists at the end.

## 4. New/changed state machines and vocabulary (not yet canonical)

### 4.1 Project lifecycle — new segment before plan activation

Current (`00-glossary-and-terms.md` §3.1):

```
active → implementation_complete → design_document_generating
    → design_document_ready_for_review → design_document_approved → project_complete
```

Proposed insertion, between clarification completing and plan/backlog generation. Candidate
names (to be finalized at implementation time and added to the glossary first):

```
active
  → preliminary_design_drafting
  → preliminary_design_ready_for_review
  → preliminary_design_revision_requested → preliminary_design_drafting   (revision loop)
  → preliminary_design_approved
  → (existing plan lifecycle: draft → pending_approval → approved → activated_for_execution)
  → ... execution ...
  → implementation_complete
  → design_document_generating   (repurposed: reconciliation, not first authorship)
  → design_document_ready_for_review
  → design_document_revision_requested → design_document_generating       (existing revision loop)
  → design_document_approved
  → project_complete
```

Open naming question: whether `preliminary_design_*` and `design_document_*` should be the same
underlying state-machine states reused twice (a document lifecycle parameterized by "which pass"),
or two textually distinct sets of states as sketched above. Reusing one machine is more
DRY but blurs "first draft, pre-execution" and "reconciliation, post-execution" in audit logs and
UI; distinct states cost more glossary/matrix surface but keep the two passes unambiguous in
`workflow_events`/timeline views. Recommend distinct states — this codebase's own convention
(e.g. `changes_requested` occurring at multiple points in the feature-execution machine, still
sharing one token, but never conflating semantically different lifecycles into one machine) favors
clarity here, and the two passes have different guards, different actors, and different downstream
consequences (one gates backlog generation; the other gates `project_complete`).

### 4.2 Plan lifecycle — new guard

`draft → pending_approval` (`SubmitPlanForApprovalCommand`) gains a new guard clause requiring the
project to be at `preliminary_design_approved` (or equivalent) before a plan can be generated
against it — mirroring the existing `backlog_validated_state = 'valid'` guard pattern
(`01-system-specification.md`/CLAUDE.md's Bootstrap Planner Operational Constraints). This is the
one hard-gate this proposal introduces: it ensures a design doc exists and is approved before
backlog generation can proceed at all, without attempting the harder per-feature/live-coherence
enforcement described in §8.

### 4.3 New review-finding vocabulary reuse

No new severity vocabulary is proposed. Design-document review findings reuse the existing
severity tokens (`00-glossary-and-terms.md` §3.7: `blocking | non_blocking | question | nit |
out_of_scope | requires_human_decision`) against a new `review_findings.finding_subject` (or
equivalent discriminator) distinguishing a design-document finding from a feature-code finding, so
existing findings tooling (`minicoder findings`, `review_findings` table, the Arbiter dispute
path) is reused rather than duplicated. Exact schema shape is implementation-time work.

## 5. Grounding mechanism (the primary anti-drift fix)

This is the change with the highest value-to-risk ratio and should be built first regardless of
what else from this proposal is adopted.

- **`PlannerAgentAdapter.generateFeatureBacklog()`/`generatePlanSections()`** gain an additive,
  optional input field carrying the approved preliminary design document's sections (or a
  relevant subset). Additive — existing callers/mocks (`MockPlannerAdapter`) keep compiling
  unchanged, matching this codebase's established pattern for widening adapter input contracts
  (e.g. `ReviewerInput`'s `featureTitle`/`acceptanceCriteria` addition, issue #47).
- **`CoderInput`/`ReviewerInput`** gain an additive `designDocumentContext` field (or the
  evidence is threaded in via constructor options on the concrete adapter, mirroring
  `ClaudeReviewerAdapter`'s existing `owner`/`repo` constructor-option pattern rather than
  widening the shared narrow input type — exact mechanism to be decided at implementation time,
  consistent with the "narrow shared input type, caller enriches via constructor options"
  convention already established for `ClaudeDocumentationAdapter`).
- **`run-coder.ts`/`run-review.ts`** are updated to fetch the project's approved design document
  sections relevant to the feature being worked (see open question in §8.1 on scoping — whole
  document vs. a relevant-sections subset) and pass them into the adapter call, the same
  "task assembles evidence, adapter consumes it" shape `run-design-doc.ts` already establishes for
  `collectDesignDocumentEvidence()`.
- No new state-machine transition is required for this piece — it is a data-plumbing change to
  existing task `runImpl`s and adapter input contracts, not a new guarded transition. It is the
  lowest-risk part of this proposal and can be implemented and shipped independently of §4's
  state-machine changes, once *some* design document exists early enough to reference (i.e. it
  still depends on §6 existing, but not on §4.2's hard gate).

## 6. LLM-based design document review

Reuses the existing Reviewer/Arbiter machinery shape (`packages/adapters-reviewer`,
`packages/adapters-arbiter`, `run-review.ts`'s review/fix loop) rather than inventing new
infrastructure:

- A design-document review pass takes the drafted `design_document_sections` and produces
  structured findings against a design-specific rubric: internal consistency (no two sections
  contradict each other), completeness against the specification and clarification answers, and
  concreteness (sections should be specific enough for a coder to ground implementation in —
  interface signatures, data shapes, module boundaries and their responsibilities, naming — not
  narrative prose alone). This is a distinct rubric from `ClaudeReviewerAdapter`'s code-review
  rubric, but the same mechanical shape: adapter call → `normalizeReviewerFindings()`-style
  normalization → findings persisted → blocking findings drive a revision loop, non-blocking
  findings are recorded for visibility only.
- Whether this reuses `ReviewerAgentAdapter` directly (with a different `ReviewerInput` shape) or
  is a new, distinct role is an open question (§8.2). Reuse is attractive because it avoids adding
  a seventh agent role (§4.1 of the glossary currently lists six); a distinct role is more
  correct if the rubric and output shape diverge significantly from code review.
- Design-review findings marked `blocking` route
  `preliminary_design_ready_for_review → preliminary_design_revision_requested →
preliminary_design_drafting` automatically (system actor) — mirroring
  `RecordChangesRequestedCommand`'s system-actor, automatic-on-blocking-findings shape, not
  `RequestDesignDocumentRevisionCommand`'s existing human-actor-only shape. The **existing**
  human approval step (`ApproveDesignDocumentCommand`-equivalent,
  `preliminary_design_ready_for_review → preliminary_design_approved`) remains a required human
  gate on top of the automated review passing — the same "AI review, human approves" split already
  established for code (Phase 10 review/fix loop + Phase 12 merge gate's human
  `merge-if-ready` step).
- A `disagreement_records`-style Arbiter path is plausible if a design reviewer and a human
  disagree, or if a design reviewer repeatedly raises the same finding — reusing
  `findRepeatedFinding()`'s existing detection shape (CLAUDE.md's Disagreement/Arbiter
  Operational Constraints) rather than building new repeat-detection logic.

## 7. Backlog coherence (secondary benefit, not the primary mechanism)

With the design doc available at backlog-generation time (§5), a secondary, optional check can
verify each generated feature references a real design-doc component/section rather than
inventing its own structure — a lighter-weight, structural or LLM-assisted check added to
`ValidateBacklogHandler`'s existing feature-quality-rule checks
(`02-bootstrap-planner-clarification.md` §9). This is worth building, but it is explicitly
secondary to §5: even without this check, threading the design doc into every Coder/Reviewer call
already does most of the anti-drift work, since it's what keeps independently-invoked agents
grounded in the same reference regardless of whether backlog generation itself was checked.

## 8. Deferred / open questions (explicitly not part of the initial increment)

### 8.1 Context scoping

Passing the *entire* design document into every Coder/Reviewer call is the simplest option but
risks bloating prompt context and cost (`cost_records`/budget-gate impact) as the document grows.
Passing only "relevant" sections requires a mapping from feature → design-doc
section/component, which itself needs either (a) the planner adapter to declare this mapping when
generating the backlog (an additive field on `FeatureInputSchema`) or (b) a retrieval step at
Coder/Reviewer invocation time. Recommend (a) for the initial increment — it is a natural
byproduct of §5's grounded backlog generation and needs no new retrieval infrastructure.

### 8.2 New agent role vs. reused `ReviewerAgentAdapter`

Whether design-document review is a new `DesignReviewerAgentAdapter` role (glossary §4.1 addition,
new mock/reference adapters, new conformance suite coverage per Phase 5's pattern) or a
parametrized reuse of the existing `ReviewerAgentAdapter` interface is an implementation-time
decision with real cost either way — a new role is more architecturally honest if the rubric
diverges meaningfully; reuse is cheaper and avoids adapter-registry/conformance-suite sprawl.

### 8.3 Write-back from execution (design doc as a *living* document)

This proposal's title mentions "the feature implementation... update the design document as
necessary." The read-side grounding in §5 does not, by itself, give execution any channel to
*change* the design doc. A future increment could let Coder/Reviewer output carry an optional
"proposed design amendment" (additive field on `CoderOutput`/`ReviewerOutput`), persisted as a
*pending*, human/LLM-reviewed revision — never applied automatically, consistent with this
codebase's consistent refusal to let an agent silently mutate durable shared state
(`human_approvals` audit trail is written for every judgment call in the system, e.g. Arbiter
dispositions, budget overrides, planning-gap resolutions).

This is deliberately **out of scope for the initial increment** because it reopens a set of
already-hard-won correctness questions this codebase's Phase 17 review process spent five rounds
getting right for the *simpler* end-of-project case (§ CLAUDE.md's `artifact_export_design_document_id`
binding fix, the atomicity-of-writes-vs-transitions fixes, the serializable-isolation fix for
`evaluateProjectAcceptance()`): specifically, what happens to a feature that is mid-`coding` when
the design doc it was grounded in changes underneath it. Does it finish as originally scoped, get
flagged for re-grounding, or block? This needs its own design pass once real drift data exists
from the read-side-only increment, not a guess baked in up front.

### 8.4 Hard coherence enforcement re-firing on amendment

If §8.3 is ever built, a hard-coherence check (§2) would also need to re-fire against
already-generated-but-not-yet-executed features when the design doc is amended mid-project — a
TOCTOU-shaped problem this codebase has repeatedly had to solve carefully elsewhere (fencing
tokens, optimistic-lock CAS, `expectedVersion`-scoped idempotency keys). Not designed here;
flagged as a dependency of §8.3, not of the base proposal.

### 8.5 Cost impact

Design-document generation and review currently run once per project (Phase 17). Moving drafting
earlier is cost-neutral by itself, but threading design-doc context into *every* Coder/Reviewer
call (§5) adds tokens to every single feature invocation for the life of the project. This should
be measured against real project sizes before deciding default behavior (always-include vs.
budget-gated vs. relevant-sections-only per §8.1) — `evaluateBudget()`/`forecastBudget()`'s
existing machinery already extends naturally to account for it once real usage data exists.

## 9. Recommended increment ordering

1. **Increment 1 (highest value, lowest risk):** move design-document drafting to immediately
   after clarification, add the LLM design-review pass with human approval (§6), and thread the
   approved document into every Coder/Reviewer invocation as grounding context (§5). Repurpose
   the existing Phase 17 machinery as an end-of-project reconciliation pass (§3) rather than
   first authorship. This directly addresses the drift risk described in §1.
2. **Increment 2:** backlog-generation grounding + the lightweight structural coherence check
   (§7), plus the feature→design-doc-section mapping from §8.1(a) if not already produced as a
   byproduct of increment 1's backlog generation.
3. **Increment 3 (deferred, needs its own design pass):** write-back/living-document channel
   (§8.3) and any hard re-coherence enforcement it requires (§8.4), once real drift/amendment
   frequency is observed from increments 1–2 in practice.

This proposal recommends implementing only Increment 1 initially, measuring its effect on
cross-feature consistency in practice, and treating Increments 2–3 as informed by that data rather
than committed up front.

## 10. Impact summary on existing canonical docs (at implementation time)

If adopted, implementation will require, in this order:

1. Add new state tokens to `00-glossary-and-terms.md` §3 (project lifecycle §3.1, new matrix rows
   in §3.9) — before any code references them, per CLAUDE.md's own rule.
2. Add new Workflow Layer task ID(s) (e.g. a `generate-preliminary-design`/`run-design-review`
   pair) to `00-glossary-and-terms.md` §3.12 and `docs/02-bootstrap-planner-clarification.md` §6.
3. Update `docs/02-bootstrap-planner-clarification.md` §5's pipeline diagram and §7 (Planner
   Agent Adapter) for the new `generateFeatureBacklog()` input field.
4. Update `docs/06-implementation-plan.md` with a new phase entry (not a competing list — an
   addition to the single canonical plan) once implementation is scheduled.
5. Update `01-system-specification.md` wherever the design-document generator's "runs once, at
   the end" framing is currently stated.

No code changes are made by this proposal document itself; it is a planning artifact only.
