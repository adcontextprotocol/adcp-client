---
'@adcp/sdk': major
---

Harden task-registry cutover and out-of-process settlement. Task creation now
returns a serializable scoped handle, lifecycle writes report applied,
already-terminal, or scoped-miss outcomes, and trusted workers can settle using
ref-based helpers. Split PostgreSQL bootstrap from a phased operator-run scope
upgrade with preflight, bounded locks, concurrent indexes, verification, and
rollback guidance. Require Node 20.19+ on the Node 20 line or Node 22.12+ so
CommonJS consumers can load the SDK's ESM dependency graph, and document and
continuously test both boundaries in the supported Node/Undici runtime matrix,
including the Undici 7 consumer-override fixture.
