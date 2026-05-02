---
"@adcp/sdk": minor
---

feat: bump AdCP spec to 3.0.4

`ADCP_VERSION` 3.0.1 → 3.0.4. Picks up three patch releases on the 3.0.x maintenance line. All changes are additive — no wire breaks for 3.0-conformant agents — but several close out items the SDK had been carrying as deferred follow-ups.

What lands wire-side (44 schema deltas, 0 potentially breaking per `npm run schema-diff`):

- **`core/error.json` gains optional `issues[]`** (adcp#3562 — closes adcp#3059). Standardizes the `VALIDATION_ERROR` issues-list shape that several response schemas had been re-declaring inline. Propagates through 41 response-schema sites, all additive. Existing handlers compile unchanged; new handlers can populate `issues[]` for structured field-level diagnostics.
- **`core/assets/asset-union.json` added** (adcp#3462). Canonical home for the asset-variant `oneOf` union that previously inlined into `creative-asset.json` and `creative-manifest.json`. The spec-side change is byte-identical to the prior inline shape. SDK codegen still emits the `VASTAsset1` / `DAASTAsset1` / `BriefAsset1` / `CatalogAsset1` numbered duplicates; converging the codegen pipeline onto the canonical `$ref` is tracked separately and not blocked by this bump.
- **`manifest.json` + `manifest.schema.json` published** (adcp#3738 — closes adcp#3725). New `/schemas/{version}/manifest.json` artifact carries 57 tools (with `protocol`, `mutating`, request/response schema refs, async response schemas, specialism mappings) and 45 error codes (`recovery`, `description`, `suggestion`, `default_unknown_recovery: "transient"` policy block). The `tools/list` MCP-exposed count is 51 — manifest covers tmp/protocol/compliance tools the SDK doesn't surface there. `enums/error-code.json` gains a structured `enumMetadata` block alongside the existing `enumDescriptions` prose. SDK consumption is tracked in #1192; this bump makes the artifact available for the codegen rewire to start.
- **`AUTH_REQUIRED` prose tightened** (3.0.4, prose-only backport of adcp#3739). The wire code stays `AUTH_REQUIRED` with `recovery: correctable` — the 3.0.x line cannot add the `AUTH_MISSING` / `AUTH_INVALID` enum split — but the description and `enumMetadata.suggestion` now spell out the two operational sub-cases (credentials missing vs. credentials presented but rejected) and the SHOULD-NOT-auto-retry rule for the rejected case. The `BuyerRetryPolicy` callout in `skills/call-adcp-agent/SKILL.md` follows. Issue #1193 stays open against the structural 3.1 split.
- **Storyboard `provides_state_for` field** (3.0.3 — adcp#3734). Spec-side field is now in the compliance cache (`compliance/cache/3.0.4/universal/storyboard-schema.yaml`). The SDK runner does not yet consume it — `sales-social` explicit-mode platforms continue to grade against the generic cascade-skip path until runner support lands. Tracked in #1267.
- **`url_type` channel-doc cleanup** (3.0.3 step 1 + 3.0.4 step 2 — adcp#2986 / adcp#3671). Replaces invalid `"url_type": "tracker"` with `"tracker_pixel"` and adds role-based fallback. Wire enum was already correct; this aligns the prose.
- **Compliance fixes** (3.0.4): audience-sync `discover_account` `stateful: false → true` (adcp#3710).

Generated regen via `npm run sync-schemas`, `sync-version --force`, `generate-types`, `generate-wellknown-schemas`, `generate-agent-docs`. `tools/list` still 51, error codes 45 (was 28; `enumMetadata` exposed the full set), storyboards 63, test scenarios 24.

Cosign verification: the regex in `scripts/sync-schemas.ts` now allows the `3.0.x` release branch alongside `main` and `2.6.x`, matching the upstream `release.yml` `on.push.branches` for the maintenance line.

`COMPATIBLE_ADCP_VERSIONS` extended to include `3.0.2`, `3.0.3`, `3.0.4`.
