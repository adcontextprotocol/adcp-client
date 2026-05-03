---
'@adcp/sdk': patch
---

docs(skills): rewrite build-si-agent SKILL.md against the v6 platform

The SI skill was scaffolded against the v5 handler-bag escape hatch
because the v6 `SponsoredIntelligencePlatform` interface didn't exist
when the skill landed. v6.7 shipped that interface (#1454) plus the
worked example (#1464) and storyboard fixtures (#1471). The skill is
now stale — adopters reading it would route through `createAdcpServer`
from `@adcp/sdk/server/legacy/v5` and miss auto-hydrated `req.session`,
typed dispatch parity with every other specialism, and the
storyboard-ready reference adapter.

This rewrite brings the skill in line with the shipped state:

- **SDK Quick Reference** lists `createAdcpServerFromPlatform`,
  `definePlatform`, and `defineSponsoredIntelligencePlatform`. Drops
  the `v5 escape hatch` callout (still works but no longer
  recommended).
- **Implementation skeleton** uses the v6 platform shape — single
  `definePlatform({ capabilities, accounts, sponsoredIntelligence })`
  literal with `defineSponsoredIntelligencePlatform<BrandMeta>({...})`.
  Matches the structure of `examples/hello_si_adapter_brand.ts`.
- **`req.session` documented** with explicit production caveat:
  framework auto-hydrates a small record (intent, offering scoping,
  identity consent, negotiated capabilities, ttl) for the fixture /
  mock case and the "what was the original scope?" lookup. Production
  brand engines almost always own full transcript state in their own
  Postgres / Redis / vector store — modeling full transcripts in
  `ctx_metadata` will hit the 16KB blob cap.
- **Storyboard validation step** points at `si_baseline` (
  `compliance/cache/latest/protocols/sponsored-intelligence/index.yaml`)
  with the reference adapter's `3/3 scenarios pass` baseline.
- **Specialism vs. protocol** framing clarified: SI is a *protocol*
  in AdCP 3.0 (`'sponsored_intelligence'` in `supported_protocols`),
  not yet a specialism (adcp#3961 for 3.1). The platform field's
  presence is the declaration; framework auto-derives the protocol
  claim from the four registered SI tools. When 3.1 lands, declaring
  `specialisms: ['sponsored-intelligence'] as const` becomes additive
  — both forms work.
- **Common Mistakes table** updated: drops "use the v5 path" guidance,
  adds new gotchas (`product_card.data.title` + `data.price` strict-
  schema requirements, the "don't model full transcripts in
  ctx_metadata" trap, the "don't declare the SI specialism yet" trap).
- **Tracking** section ties to adcp#3961 + adcp#3981 so adopters can
  follow upstream movement.

The skill matrix entry (`scripts/manual-testing/skill-matrix.json`)
already maps `build-si-agent/SKILL.md` to the `si_baseline` storyboard
— that pairing now passes 3/3 with the rewritten skill driving the v6
example.

Refs adcontextprotocol/adcp#3961, #3981, adcp-client#1441, #1454,
#1464, #1471.
