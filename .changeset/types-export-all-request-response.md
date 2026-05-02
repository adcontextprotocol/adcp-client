---
"@adcp/sdk": minor
---

feat(types): re-export all spec-defined request/response types from `@adcp/sdk/types`

`@adcp/sdk/types` previously re-exported only a curated subset of wire types, leaving
`GetMediaBuysRequest`, `ListCreativeFormatsRequest/Response`, and ~50 other operation
types accessible only via `@adcp/sdk/tools.generated` — a generated file CLAUDE.md
explicitly tells adopters not to reach into.

This change completes the barrel so all spec-defined operation `*Request`, `*Response`,
`*Success`, `*Error`, and `*Submitted` types are importable from `@adcp/sdk/types`.
The single large block is replaced with per-domain named sections (accounts,
capabilities, media buy, audiences/catalogs/events, signals, creative, governance,
sponsored intelligence) for maintainability.

Intentionally excluded: comply-runner internals (`ComplyTestControllerRequest/Response`,
`SeedSuccess`, `SimulationSuccess`, `ControllerError`), sub-shapes accessible
transitively (`PaginationRequest/Response`, `PackageRequest`), and types whose names
conflict with legacy `adcp.ts` shapes already in the public surface
(`SyncCreativesRequest`, `ListCreativesRequest/Response`).
