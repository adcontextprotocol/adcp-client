# DecisioningPlatform v6.2 / 6.3 — universal state management

## Status

Design vision. Captures the systems-thinking direction surfaced during the 6.1 ctx_metadata work. Not yet implementation-ready — needs adopter validation (Scope3, Prebid, AudioStack) and protocol coordination with `adcontextprotocol/adcp` for the proposal-flow vocabulary.

## Thesis

**Protect the user from state management universally.** Publishers connect business logic; the SDK does state, conversation history, hydration, and protocol handshake.

The 6.1 ctx_metadata + auto-hydration work proved this on `getProducts → createMediaBuy`. Apply the same pattern to every multi-call workflow the protocol defines:

- Brief-driven proposal generation (`generateProposal → refineProposal → finalizeProposal`)
- Creative refinement (`buildCreative → refineCreative` with conversation history)
- Buyer approval flows for generative creative
- Catalog-driven sandbox seeding for compliance testing

## What 6.1 shipped (substrate)

- `CtxMetadataStore` + `setResource` / `setEntry` for combined `value` (publisher blob) + `resource` (SDK wire object) round-trip
- Auto-store on `getProducts` / `getMediaBuys` returns
- Auto-hydrate `req.packages[i].product` on `createMediaBuy`
- `ctx.ctxMetadata.product(id)` accessor as escape hatch
- Universal across resource kinds: `product`, `media_buy`, `package`, `creative`, `audience`, `signal`, `rights_grant`, `property_list`, `collection_list`

## 6.2 — refine + proposal flow

### Refine creative (multi-turn conversation auto-state)

Today's `refineCreative` takes a creative_id and a refinement message. Publisher has to remember the original `build_creative` request, the previous iteration, and any feedback the buyer attached across calls.

**Proposed:** SDK auto-stores the original `build_creative` request + each iteration + buyer feedback. On `refineCreative`, the publisher receives:

```ts
refineCreative: async (req, ctx) => {
  // SDK has hydrated everything from the prior session:
  req.creative.ctx_metadata        // publisher's adapter state
  req.creative.original_request    // the brief + assets that started this thread
  req.creative.history             // [{role: 'buyer'|'seller', message, at, iteration}]
  req.message                      // current buyer feedback
  
  // Publisher just generates the next iteration — no DB lookup
  const nextVersion = await this.gen.refineWithHistory(req.creative.history, req.message);
  return {
    creative_id: req.creative.creative_id,
    iteration: req.creative.history.length + 1,
    assets: nextVersion.assets,
    ctx_metadata: { gen_session_id: nextVersion.sessionId },
  };
}
```

If MCP doesn't propagate session history natively, the SDK reconstructs from its store. Buyer-facing wire shape unchanged; the auto-state is invisible to them.

### Proposal flow as separate methods

Today's `getProducts` is overloaded: catalog lookup AND brief-driven proposal generation. Buyers can't predict the cost (catalog is fast, proposal is slow with potentially HITL). Publishers handle both shapes in one method.

**Proposed split:**

```ts
sales: SalesPlatform = {
  // Catalog (sync, fast, non-guaranteed):
  getProductsFromCatalog: async (filter, ctx) => {
    return { products: await this.gam.products.search(filter) };
  },

  // Proposal (async, brief-driven, may go HITL):
  generateProposal: async (brief, ctx) => {
    const proposalId = await this.proposalEngine.start(brief);
    return ctx.handoffToTask(async (taskCtx) => {
      const proposal = await this.proposalEngine.complete(proposalId);
      return { proposal_id: proposalId, products: proposal.products };
    });
  },
  refineProposal: async (req, ctx) => {
    // SDK auto-hydrated req.proposal with original brief + iteration history
    const next = await this.proposalEngine.refine(req.proposal_id, req.feedback);
    return { proposal_id: req.proposal_id, products: next.products };
  },
  finalizeProposal: async (proposalId, ctx) => {
    // Locks the proposal; subsequent createMediaBuy must reference these products
    await this.proposalEngine.lock(proposalId);
    return { proposal_id: proposalId, locked: true };
  },
};
```

Buyers know what to expect from each verb. Publishers split implementations along the natural fault line. SDK auto-hydrates the proposal's brief + history on every refine/finalize call.

**No spec change needed.** The wire stays existing — `get_products` still serves both catalog and proposal traffic per the current spec. The SDK provides `getProductsFromCatalog` / `generateProposal` / `refineProposal` / `finalizeProposal` as ergonomic SalesPlatform methods that the framework dispatches to the same `get_products` wire verb (and the existing proposal-mode async path). Adopters claiming `sales-non-guaranteed` only implement `getProductsFromCatalog`; adopters claiming `sales-proposal-mode` implement the proposal trio. Same wire surface, cleaner publisher code.

### Catalog-as-comply-sandbox

`comply_test_controller` lets storyboards seed test fixtures. Today the publisher implements seed adapters explicitly. Emma round 2 surfaced that LLM-generated platforms miss `seed_product` / `seed_pricing_option` because the slim skill doesn't show them.

**Proposed:** when the `AccountReference.sandbox === true` (or a new `comply: true` flag), framework auto-derives `seed_product` from `getProductsFromCatalog`. Storyboard sends `seed_product { product_id: 'sports_display_auction' }`; framework returns the catalog entry by id without invoking the publisher's adapter. Same for `seed_pricing_option` — derived from each catalog product's `pricing_options[]`.

Publishers wiring `getProductsFromCatalog` get free comply-sandbox seeding. `force_*` and `simulate_*` adapters still need explicit wiring (they're stateful), but the seed surface vanishes.

**Spec idea:** `make_me_a_comply_sandbox: true` on `get_adcp_capabilities` declares "this account auto-seeds from the catalog." Buyers running storyboards know what to expect.

## 6.3 — assembly helpers

Simple products are rate card + placement + audience. Today the publisher constructs the AdCP `Product` shape by hand, including `format_ids`, `pricing_options[]`, `delivery_type`, etc.

**Proposed helpers:**

```ts
import { buildProduct, buildPricingOption } from '@adcp/sdk/server';

const product = buildProduct({
  product_id: 'sports_display_auction',
  name: 'Sports Display Auction',
  formats: ['display_300x250', 'display_728x90'],   // string array → format_ids: [{id}, {id}]
  rate_card: {
    cpm: 12.50,
    currency: 'USD',
    floor: 8.00,
  },
  audience: { /* targeting capabilities scaffold */ },
  ctx_metadata: { gam: { ad_unit_ids: [...] } },
});
```

Reduces ~30 lines of wire-shape boilerplate per product. Optional — adopters with non-standard products construct directly.

## Account ctx_metadata flow

Same pattern, applied to Account. Today `accounts.resolve()` returns `Account<TMeta>` with publisher's typed metadata. The user-facing equivalent of "publisher attaches adapter state, SDK round-trips" should work for accounts too:

```ts
accounts = {
  resolve: async (ref, ctx) => ({
    id: 'acct_main',
    operator: 'mypub',
    metadata: { /* TMeta — publisher's typed shape */ },
    ctx_metadata: { gam: { network_code: '12345', advertiser_id: 'adv_xyz' } },  // NEW
  }),
};

// Publisher reads anywhere:
ctx.account.ctx_metadata?.gam?.advertiser_id
```

Same SDK round-trip semantics. `sync_accounts` returns can attach ctx_metadata; SDK persists per (account_id, 'account', account_id); `accounts.resolve()` hydrates it from the store on subsequent requests.

## What this delivers

Publishers connect business logic. SDK does:

- **Wire protocol** (already)
- **Idempotency** (already)
- **HITL task envelopes** (already)
- **State per resource** (6.1 ctx_metadata)
- **Wire-shape hydration** (6.1 auto-hydrate)
- **Multi-call workflow state** (6.2 refine + proposal history)
- **Compliance-sandbox catalog scaffolding** (6.2 seed-from-catalog)
- **Assembly boilerplate** (6.3 buildProduct/buildPricingOption)
- **Account-level adapter state** (6.2 account.ctx_metadata)

The "5-6 functions, you're done" thesis collapses to "connect your platform API. The SDK is everything else."

## Open questions

1. **Wire-spec coordination for `generateProposal/refineProposal/finalizeProposal`.** Worth proposing as a new section in `adcontextprotocol/adcp` — proposal flow has been "stuffed into get_products" historically and no spec verbs exist.

2. **Conversation history wire shape.** MCP doesn't carry session-history natively. Need to decide: SDK round-trips via ctx_metadata.history (additive, no spec change), or push for a `conversation_id` wire field that buyers thread across refine calls.

3. **Refine creative auto-state cost.** The history can grow unbounded. Cap at N iterations? Truncate older messages? Move to summarization for context-window economy?

4. **Catalog-sandbox semantics.** When does framework intercept `seed_product` vs delegate to the publisher's adapter? Probably: framework intercepts iff the requested `product_id` exists in `getProductsFromCatalog`'s output; otherwise delegates. Edge case: storyboards that seed synthetic IDs the catalog never returns.

5. **buildProduct optionality.** Mandate it on the slim skill (LLMs use the helper), or keep optional (adopters with non-standard products bypass)?

## Proposed implementation order

| Order | Work | Cost | Risk |
|---|---|---|---|
| 1 | Account ctx_metadata flow | ~200 LOC | Low — extends existing pattern |
| 2 | `buildProduct` / `buildPricingOption` helpers | ~150 LOC | Low — pure factory functions |
| 3 | Catalog-as-sandbox auto-derive | ~300 LOC | Medium — touches `comply_test_controller` |
| 4 | Refine creative auto-state | ~400 LOC | Medium — needs history schema decision |
| 5 | Proposal flow split (`generate/refine/finalize`) | ~600 LOC | Low — SDK ergonomics over existing wire |

All items are SDK-internal. No `adcontextprotocol/adcp` spec coordination required — the wire stays as existing verbs throughout.
