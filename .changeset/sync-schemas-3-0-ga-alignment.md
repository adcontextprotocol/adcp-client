---
'@adcp/client': minor
---

Sync generated types to AdCP 3.0 GA and consolidate the 4.x → 5.x migration guide.

**Generated-type changes** (in `src/lib/types/*.generated.ts`, re-exported via `@adcp/client` and `@adcp/client/types`):

- **Asset types** (`ImageAsset`, `VideoAsset`, `AudioAsset`, `TextAsset`, `URLAsset`, `HTMLAsset`, `JavaScriptAsset`, `WebhookAsset`, `CSSAsset`, `MarkdownAsset`, `BriefAsset`, `CatalogAsset`, `VASTAsset`, `DAASTAsset`) gain a required `asset_type` literal discriminator (e.g. `asset_type: 'image'`). Handlers that construct asset literals must populate it.
- **`GetProductsRequest.refine[]`** — `id` renamed to `product_id` (product scope) / `proposal_id` (proposal scope); `action` is now optional (defaults to `'include'`). New-in-GA surface — beta.3 clients never sent this.
- **`GetProductsResponse.refinement_applied[]`** — flat object replaced by a discriminated `oneOf` union on `scope`. Each arm carries `product_id`/`proposal_id` (previously a shared `id`). New-in-GA surface.
- **VAST/DAAST** — common fields (`vast_version`, `tracking_events`, `vpaid_enabled`, `duration_ms`, `captions_url`, `audio_description_url`) hoisted from inside each `oneOf` arm to the base object. Wire payloads are unchanged; codegen is cleaner.
- **Governance plan requests** (`ReportPlanOutcomeRequest`, `GetPlanAuditLogsRequest`, `CheckGovernanceRequest`) — tightened to reject redundant `account` fields alongside `plan_id`. New-in-GA surface.

**Wire-level compatibility.** Against the previously-compatible AdCP `3.0.0-beta.3`, the only bidirectional wire breaker is the asset `asset_type` discriminator: a GA client strictly validating an asset payload from a beta.3 server will reject, because beta.3 servers don't emit the discriminator. Set `validation: { requests: 'warn' }` if you need that traffic to flow. Every other change is either TS-only (same JSON on the wire) or new-in-GA surface that beta.3 counterparties never exercise. rc.1 / rc.2 clients sending GA servers the old `refine[].id` shape will be rejected (`additionalProperties: false`) — upgrade the client.

**If upgrading your handlers:** (1) populate `asset_type` on every asset literal your handlers construct (`"image"`, `"video"`, `"vast"`, `"daast"`, …); (2) rename `refine[].id` → `refine[].product_id` / `refine[].proposal_id` on the scope-matching arm; (3) run `tsc --noEmit` — tightened brand-rights + `DomainHandler` return types will point to every drift site. Full walkthrough in [`docs/migration-4.x-to-5.x.md`](../docs/migration-4.x-to-5.x.md) Part 9.

**Migration doc consolidated.** `docs/migration-4.30-to-5.2.md` and `docs/migration-5.3-to-5.4.md` are superseded by `docs/migration-4.x-to-5.x.md`, which walks the full 4.x → 5.x train release-by-release and includes a wire-interop matrix near the top.

**New dev tool: `npm run schema-diff`.** Compares `schemas/cache/latest/` against the snapshot captured on the previous `npm run sync-schemas` run (now written to `schemas/cache/latest.previous/`). Groups wire-level changes by kind (field renames, newly-required fields, `additionalProperties` tightened, `oneOf` arm count changes, enum deltas) so the output surfaces interop concerns without re-reading 700 lines of generated TS. Run with no args for the default before/after pair, or pass two directories: `npm run schema-diff -- <dirA> <dirB>`.
