# MiniCoder — Agent Adapter Architecture Specification

## 1. Purpose

MiniCoder uses vendor-neutral agent adapters.

---

## 2. Testing Requirement

Every adapter must have conformance tests.

Required mock adapters:

- MockPlannerAdapter
- MockCoderAdapter
- MockReviewerAdapter
- MockArbiterAdapter
- MockDocumentationAdapter
- HumanTestAdapter

Adapters must support deterministic test scenarios.

---

## 3. Trigger.dev

Adapter invocations may run as Trigger.dev tasks.

Task retries must be idempotent.

---

## 4. Observability

Store structured outputs and evidence, not private chain-of-thought.

---

## 5. Acceptance

- Adapter can run in test mode.
- Adapter validates capabilities.
- Adapter normalizes outputs.
- Adapter redacts secrets.
