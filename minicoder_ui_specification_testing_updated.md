# MiniCoder — UI Specification

## 1. Purpose

MiniCoder provides an Ink TUI and Next.js Web UI.

---

## 2. Testing and State Lifecycle UI

The UI should expose:

- database state status
- Trigger.dev run/waitpoint status
- GitHub webhook/reconciliation status
- state doctor results
- failed outbox/inbox events
- test scenario results
- diagnostics exports
- environment mode

Admin UI actions may include:

- run state validation
- trigger reconciliation
- export diagnostics
- view system test history
- view stuck Trigger.dev runs
- view stale workflow locks

Destructive actions must be guarded and backend-authorized.

---

## 3. Acceptance

- UI shows state health.
- UI shows test/scenario status.
- UI does not perform direct state mutation.
