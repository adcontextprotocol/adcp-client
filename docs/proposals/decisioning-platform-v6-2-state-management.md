# DecisioningPlatform v6.2 / 6.3 — universal state management

## Status

**Superseded.** This RFC bundled five workstreams under one heading. Two have shipped; the remaining three are tracked as focused issues so each can be triaged on its own merits.

## What shipped

| Workstream | Where it landed |
|---|---|
| Account ctx_metadata flow | 6.0 — `Account.metadata` → `Account.ctx_metadata`, threaded through `accounts.resolve()` and the `ctx.account.ctx_metadata` accessor |
| `buildProduct` / `buildPricingOption` / `buildPackage` helpers | 6.0 — exported from `@adcp/sdk/server` |
| Per-resource ctx_metadata store + auto-hydration on `getProducts → createMediaBuy` | 6.1 — `CtxMetadataStore`, `ctx.ctxMetadata.product()`, package-level auto-hydration |

## Open work (now tracked as issues)

| Workstream | Issue |
|---|---|
| Catalog-as-comply-sandbox auto-derive (`seed_product` / `seed_pricing_option`) | [#1091](https://github.com/adcontextprotocol/adcp-client/issues/1091) |
| `refine_creative` auto-state — multi-turn conversation history hydration | [#1092](https://github.com/adcontextprotocol/adcp-client/issues/1092) |
| Proposal-flow `SalesPlatform` methods (`generateProposal` / `refineProposal` / `finalizeProposal`) | [#1093](https://github.com/adcontextprotocol/adcp-client/issues/1093) |

Each issue carries the design context, acceptance criteria, and open questions originally captured here. Read those rather than this file going forward.

## Thesis (preserved as-is)

**Protect the user from state management universally.** Publishers connect business logic; the SDK does state, conversation history, hydration, and protocol handshake. The 6.1 ctx_metadata + auto-hydration work proved this on `getProducts → createMediaBuy`; the open issues above extend the same substrate to every multi-call workflow the protocol defines.
