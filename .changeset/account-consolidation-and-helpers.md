---
'@adcp/sdk': minor
---

Consolidate Account state, deprecate v5 entry, ship assembly helpers, audit spec for state-management opportunities.

**Account consolidation:** drop `ctx_metadata` from `Account`. The previously-added field duplicated the existing `metadata: TMeta` (publisher-typed shape, framework-stripped from wire). Account is special among DecisioningPlatform resources because `accounts.resolve()` runs per-request — the publisher is the canonical source of truth on every call, no SDK round-trip cache needed (unlike Product/MediaBuy/Package/Creative where the SDK bridges between `getProducts` and `createMediaBuy`). Use `metadata` for adapter state on accounts.

**`createAdcpServer` deprecation:** marked `@deprecated` in JSDoc. v6 platform adopters scaffolding from skills should use `createAdcpServerFromPlatform` exclusively. Empirical baseline (Emma matrix v18 round 3) showed LLM-generated platforms picking the v5 `createAdcpServer` handler-bag entry over the v6 platform shape, bypassing `ctx_metadata` + auto-hydration. `@deprecated` flags the v5 entry in IDE / LLM scaffolds without breaking adopters mid-migration.

**Assembly helpers:** new `buildProduct` / `buildPricingOption` / `buildPackage` factories. Emit wire-correct shapes (passes AdCP 3.0.1 schema validation) from intent-shaped input — eliminates ~30 lines of boilerplate per Product. Required fields the LLM keeps missing (`publisher_properties[].publisher_domain`, `format_ids[].agent_url`, `reporting_capabilities`) get sensible defaults or loud "missing publisher_domain" errors with explicit recovery hints.

```ts
import { buildProduct, buildPricingOption } from '@adcp/sdk/server';

const product = buildProduct({
  id: 'sports_display_auction',
  name: 'Sports Display Auction',
  formats: ['display_300x250'],
  delivery_type: 'non_guaranteed',
  pricing: { model: 'cpm', floor: 5.0, currency: 'USD' },
  publisher_domain: 'sports.example',
  agentUrl: 'http://127.0.0.1:4200/mcp',
  ctx_metadata: { gam: { ad_unit_ids: ['au_123'] } },
});
```

**Spec audit RFC:** new `docs/proposals/decisioning-platform-state-audit.md` walks every AdCP wire tool, identifies which fields reference an id from a prior tool's output, and ranks state-management opportunities by leverage. Six multi-call workflows surface (media-buy lifecycle, creative refinement, proposal flow, brand rights, signals, performance feedback). Implementation priority order with LOC estimates per workflow. Informs 6.2 + 6.3 work.

**6.2 RFC clarification:** `docs/proposals/decisioning-platform-v6-2-state-management.md` updated — proposal flow split (`generateProposal/refineProposal/finalizeProposal`) is SDK ergonomics over the existing `get_products` wire verb, dispatched by claimed specialism. No `adcontextprotocol/adcp` spec coordination needed.

211 tests passing on focused suite (added 16 for assembly helpers).
