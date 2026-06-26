---
'@adcp/sdk': minor
---

Add public bare-format-id → canonical resolvers `resolveCanonicalFormatKind(id, { agentUrl? })` and `canonicalDeclarationFromBareId(id, { agentUrl? })`. Adopters migrating off legacy format storage hold bare id strings (`display_300x250_image`, `video_standard_30s`) persisted before the `{ agent_url, id }` structured-ref convention. These lift a bare id to its v2 canonical `format_kind` (or a full `ProductFormatDeclaration` carrying `v1_format_ref`) using the same registry- and catalog-backed resolution the v1 → v2 product projection uses, replacing hand-rolled `inferFormatKindFromFormatId` heuristics with one source of truth. Both fail closed — returning `null`, never a guess — for unknown, under-specified, or foreign-catalog ids. Exported from the package root and `@adcp/sdk/v2/projection`; `V2ProductFormatDeclaration` is now also re-exported from the root as the public return type.
