---
'@adcp/client': patch
---

Two regressions from the 5.14 train (closes #862). Both restore documented
behavior — no new surface, no new policy. **5.14.0 consumers should upgrade
directly to this release; no code changes required.**

### (1) Schema loader: flat-tree domain `$ref` resolution

`ensureCoreLoaded` pre-registered only `core/` and `enums/` before AJV
compile. Tool schemas in flat-tree domain directories — `governance/`,
`brand/`, `property/`, `collection/`, `content-standards/`, `account/`,
`signals/` — ship alongside sibling building-block fragments they `$ref`,
and those siblings were never registered. First compile of e.g.
`governance/sync-plans-request.json` threw `can't resolve reference
/schemas/3.0.0/governance/audience-constraints.json`.

The loader now walks every directory outside `bundled/` and pre-registers
non-tool JSON fragments — covering `core/`, `enums/`, `pricing-options/`,
`error-details/`, `extensions/`, and every flat-tree domain's sibling
building blocks. Tool request/response files stay lazy-compiled so
`relaxResponseRoot` still applies to response variants.

**Blast radius is broader than storyboards.** The same `getValidator` is
wired into strict-mode request/response validation
(`AdcpClient({ strict: true })`, `createAdcpServer` default validation,
`validateOutgoingRequest` / `validateIncomingResponse`, the dispatcher
middleware, and `TaskExecutor`). Any 5.14.0 server-side adopter running
strict validation on governance/brand/property/signals/collection/
content-standards/account tools was silently throwing on first call;
those paths are fixed by this release too.

### (2) `create_media_buy` enricher: fixture-per-package precedence

The fixture-authoritative refactor in 5.14 (#816) set every task's
top-level merge to fixture-wins, but the nested-package merge in
`create_media_buy` kept the prior builder-authoritative precedence.
Storyboards that authored explicit `product_id` / `pricing_option_id` /
`bid_price` on `packages[0]` had those values overridden by the first
discovered product's `pricing_options[0]` — e.g. a seller's
`pinnacle_news_video_premium_pricing_0` replaced the fixture's
`cpm_guaranteed`, failing create-buy with `INVALID_REQUEST`.

Fixture now wins on every per-package identifier. Discovery still
gap-fills when the author omits per-package ids — the behavior
generic single-package storyboards rely on. Auction/CPM `bid_price`
synthesis only fires when the fixture didn't author one, so
bid-floor-boundary tests keep their explicit values.

**Migration note.** If a storyboard was intentionally relying on
discovery overriding an authored `product_id` / `pricing_option_id` /
`bid_price` (e.g. `pricing_option_id: "placeholder"` expecting the
enricher to rewrite it), remove the fixture value so gap-fill kicks
in, or align the fixture value with the seller's catalog.

### Out of scope

Issue #862 also flagged `activate_signal` as "same pattern". The
enricher is not `FIXTURE_AWARE` — the outer merge lets the storyboard's
`$context.first_signal_pricing_option_id` overlay the enricher's pick,
and both resolve from the same `signals[0].pricing_options[0]`. The
mismatch reporters saw (`po_prism_abandoner_cpm` sent,
`po_prism_cart_cpm` accepted) traces to seller catalog inconsistency
between `get_signals` and `activate_signal`, not SDK synthesis. A
follow-up to have the storyboard runner emit a hint when a response's
`available:` list excludes a context-derived `pricing_option_id` will
land separately.
