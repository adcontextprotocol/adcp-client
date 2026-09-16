---
'@adcp/sdk': minor
---

Add a transactional PostgreSQL reporting lifecycle activity bridge with schema-conformant health notifications, finality-aware account activity, stable event identity, fenced crash recovery, tenant-scoped pagination, and reuse of persistent notification webhook delivery. Finality-only lifecycle transitions are newly recorded for internal activity but do not emit the health-only AdCP webhook. Pre-v14 transitions without a recorded finality now resolve their baseline through `ReportingLedgerStore.resolveTransitionFinalityBaseline`, which derives it once from the revision record's own `createdAt` and persists it, so the lifecycle decision and the store's compare-and-set can no longer disagree across the application and database clocks.
