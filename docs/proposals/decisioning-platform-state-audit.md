# Multi-call workflow state audit

## Method

Walk every AdCP wire tool. For each, identify which fields reference an id from a prior tool's output. Each cross-tool reference is a candidate for SDK auto-hydration (publisher attaches state on the producing tool, SDK round-trips on the consuming tool).

Auto-hydration eliminates re-derivation boilerplate AND makes the publisher's data visible in the function signature (LLMs scaffold to signatures, miss accessors).

## Tools producing referenceable state (the "stash on these" tools)

| Tool | Returns ids of | Currently auto-stored? |
|---|---|---|
| `get_products` | `product_id` | ✅ 6.1 (with ctx_metadata + wire shape) |
| `create_media_buy` | `media_buy_id`, `package_id`s | ❌ — needs auto-store on success arm |
| `get_media_buys` | `media_buy_id`, `package_id`s | ✅ 6.1 (top-level only; nested packages NOT auto-stored) |
| `sync_creatives` | `creative_id`s | ❌ — needs auto-store |
| `list_creatives` | `creative_id`s | ❌ — needs auto-store |
| `build_creative` | `creative_manifest_id` (and inner `creative_ids`) | ❌ — needs auto-store; refine workflow depends on this |
| `get_signals` | `signal_id`s | ❌ — needs auto-store |
| `list_audiences` | `audience_id`s | ❌ — needs auto-store |
| `get_brand_identity` | `brand_id` | ❌ — needs auto-store |
| `get_rights` | `rights_grant_id`s, `pricing_option_id`s | ❌ — needs auto-store |
| `acquire_rights` | `rights_grant_id` | ❌ — needs auto-store on Acquired arm |
| `list_property_lists` | `property_list_id`s | ❌ |
| `list_collection_lists` | `collection_list_id`s | ❌ |
| `list_content_standards` | `content_standards_id`s | ❌ |
| `sync_accounts` | `account_id`s | n/a — Account uses `metadata`, not ctx_metadata cache |
| `list_accounts` | `account_id`s | n/a — same |

## Tools consuming referenceable state (the "hydrate these" tools)

| Tool | References | Auto-hydration target | Status |
|---|---|---|---|
| `create_media_buy` | `packages[i].product_id` | `req.packages[i].product` | ✅ 6.1 |
| `update_media_buy` | `media_buy_id`, `packages[i].package_id` | `req.media_buy`, `req.packages[i].package` | ❌ next |
| `sync_creatives` | `creatives[i].creative_id` (refine path) | `req.creatives[i].priorCreative` | ❌ — refine workflow |
| `get_media_buy_delivery` | `media_buy_id`s | `req.media_buys` map | ❌ |
| `provide_performance_feedback` | `media_buy_id`, `package_id`, `creative_id`, `signal_id` | per-resource | ❌ — multiple refs |
| `activate_signal` | `signal_id` | `req.signal` | ❌ |
| `acquire_rights` | `rights_pricing_option_id`, `brand_id` | `req.brand`, `req.pricingOption` | ❌ |
| `refine_creative` (NEW — see 6.3) | `creative_id` + history | `req.creative.history`, `req.creative.original_request` | ❌ — biggest auto-state win |
| `apply_property_list` (sub-field on packages) | `property_list_id`, `collection_list_id` | nested in packages | ❌ |
| `tasks_get` | `task_id` | already framework-internal | ✅ |
| `log_event` | `media_buy_id`, `package_id`, `creative_id`, `event_source_id` | per-resource | ❌ |
| `report_plan_outcome` | `plan_id`, `media_buy_id`s | per-resource | ❌ |

## Multi-step workflows (highest leverage)

These are ordered tool sequences where auto-state across calls compounds. Each is a "make it just work" target.

### 1. **Media-buy lifecycle** (5 tools, partially auto-stated)
```
get_products  → create_media_buy → sync_creatives → update_media_buy → get_media_buy_delivery
   ✅ stored        ✅ hydrated        ❌                ❌                  ❌
                    ❌ stored (resp)
```
**Gap:** `create_media_buy`'s success arm should auto-store `media_buy_id` + `packages` so `update_media_buy` can hydrate.
**Fix scope:** ~100 LOC in dispatch wrapper.

### 2. **Creative refinement** (build → refine, often multi-iteration)
```
build_creative → refine_creative → buyer_approval → finalize_creative
    ❌ stored       ❌ hydrated        (NEW — sec)      (NEW — sec)
```
**Gap:** entire pipeline. Today refining a creative requires the publisher to remember the original brief, every iteration's output, every buyer feedback message. SDK can round-trip the conversation history via ctx_metadata.
**Fix scope:** ~400 LOC + history schema decision. **Largest single state-management win.**

### 3. **Proposal flow** (sales-proposal-mode)
```
get_products(brief)  →  refine_proposal  →  finalize_proposal  →  create_media_buy
    ❌ stored             ❌ hydrated           ❌ hydrated            ❌ hydrated
```
Today this is all wedged into `get_products` overloaded behavior. SDK could expose `getProductsFromCatalog / generateProposal / refineProposal / finalizeProposal` as separate methods that internally dispatch to existing wire verbs — see 6.2 RFC.
**Fix scope:** ~600 LOC. Highest publisher-ergonomics win; LLMs can split implementations along natural fault lines.

### 4. **Brand rights** (3 tools, no auto-state)
```
get_brand_identity → get_rights → acquire_rights
   ❌ stored          ❌ stored      ❌ hydrated
```
**Gap:** publisher repeats brand resolution + rights query on every acquire call.
**Fix scope:** ~200 LOC.

### 5. **Signals** (2 tools)
```
get_signals → activate_signal
  ❌ stored     ❌ hydrated
```
**Fix scope:** ~80 LOC. Smallest but lowest cost.

### 6. **Performance feedback** (4-resource cross-reference)
```
provide_performance_feedback receives:
  - media_buy_id, package_id, creative_id, signal_id
```
If all 4 are stored from prior tools, hydration gives the publisher rich context. But this tool's purpose is for the buyer to TELL the publisher about delivery — the publisher's adapter state is less relevant than buyer-supplied metrics. Lower priority.

## Implementation priority

Ordered by cost / leverage:

| Order | Workflow | Cost | Leverage |
|---|---|---|---|
| 1 | Media-buy lifecycle (auto-store on createMediaBuy + hydrate on update) | ~100 LOC | High — most common path |
| 2 | Signals (auto-store getSignals + hydrate activateSignal) | ~80 LOC | Medium — small spec footprint |
| 3 | Brand rights (auto-store getRights + hydrate acquireRights) | ~200 LOC | Medium — brand-rights spec is non-trivial |
| 4 | Creative refinement (entire pipeline) | ~400 LOC + history schema | **Highest** — biggest single win |
| 5 | Proposal flow split (separate SalesPlatform methods) | ~600 LOC | High — splits ambiguous get_products |
| 6 | Performance feedback hydration | ~150 LOC | Low — write-only buyer-driven |

## What ships in 6.2 vs 6.3

**6.2 (state management substrate):**
- Order 1: media-buy lifecycle hydration (extends existing 6.1 work)
- Order 2: signals
- Order 3: brand rights
- Order 6: performance feedback (defensive — auto-hydrate when ids are stored)

Total: ~530 LOC. Expands the auto-hydration pattern uniformly across simple referencing tools.

**6.3 (workflow restructuring):**
- Order 4: creative refinement (new method shapes — `refineCreative` with auto-state)
- Order 5: proposal flow (new method shapes — `generateProposal/refineProposal/finalizeProposal`)

Total: ~1000 LOC. These are method-surface changes, not just wire-shape hydration. Need adopter validation before locking.

**6.x deferred (advanced):**
- Step 1 in this RFC's earlier draft: Account ctx_metadata — DROPPED. `metadata` is sufficient; accounts.resolve is per-request.
- Order 6: cross-resource dehydration (e.g., signals referenced from media_buy targeting). Overkill — the wire surface is mostly flat enough that nested refs aren't worth dehydration.

## What this delivers

After 6.2 + 6.3:

- Every multi-call workflow has SDK-managed state across calls.
- Publishers connect business logic only — every reference (`product_id`, `media_buy_id`, `creative_id`, `signal_id`, `rights_grant_id`, `audience_id`, `brand_id`) gets hydrated by the framework when the buyer passes it.
- LLMs scaffolding from skills see hydrated objects in function signatures, can't miss the data path.
- The "5-6 functions, you're done" thesis becomes "implement domain logic; the SDK is everything else."

The systems thesis from this design line — "protect the user from state management universally" — is directly enforceable by walking the table above.
