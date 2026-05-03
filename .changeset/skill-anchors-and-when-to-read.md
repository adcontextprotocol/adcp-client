---
"@adcp/sdk": patch
---

Close three single-reviewer prose-polish items deferred from PR #1496 expert review, plus a related sweep on seller adapter format declarations.

**Cross-cutting anchor links** (`skills/cross-cutting.md`)
docs-expert deferred: build-* skills had no way to deep-link into specific cross-cutting rules, so adopters fetching the file pulled the whole thing for context they didn't need. Added a "Quick reference" TOC at the top mapping each rule to its anchor — skill prose can now link to `../cross-cutting.md#idempotency_key-is-required-on-every-mutating-call` etc. and adopters land on a 5-line block instead of the 73-line file.

**Specialism subpages "when to read" framing** (`skills/build-seller-agent/SKILL.md`)
docs-expert deferred: the seven `specialisms/sales-*.md` bullets in the seller skill said *what's in the subpage* but not *when an adopter needs to read it* — so adopters skipped the bullets when triaging a fresh build. Reframed each bullet as `specialism → when to read → what's in it`. Audience: a publisher engineer cold-reading the skill now lands on the right subpage in one pass.

**`signal-owned` deletion-fork seam list** (`skills/build-signals-agent/SKILL.md`)
dx-expert deferred: the `signal-owned` row in the fork-target table told adopters to "Fork the marketplace adapter; collapse the multi-provider seed" with zero recipe for what "collapse" meant. A 1P data team at a retailer reading this cold couldn't act. Added a "What to delete if you're single-specialism `signal-owned`" block naming concrete symbols: replace the multi-provider `UpstreamCohort` seed, strip the `(data_provider_domain, data_provider_id)` filter paths, set `signal_type: 'owned'`, drop the marketplace-discovery sub-scenario. Plus a "Keep" list so adopters don't accidentally delete tenant isolation. Mirrors the convergent fix from PR #1496 for governance + brand-rights skills.

**Seller adapter format slot declaration** (`examples/hello_seller_adapter_non_guaranteed.ts`)
Spotted while sweeping for related drift: the seller's `listCreativeFormats` returned formats with no `assets[]` declarations at all, so buyers calling `sync_creatives` had no spec-aligned signal for what asset_id slots to key their `creative_manifest.assets` map against (per `creative-manifest.json:14`). Added input slots — `image` + `click_url` for display formats, `video` + `click_url` for video formats — using the same `FormatAsset.{image,video,url}` builder pattern as the creative adapters from PR #1511. Pure additive; existing buyer flows don't change.

Validated: fork-matrix 23/23, typecheck + format clean.
