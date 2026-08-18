# AdCP 3.2 proposal negotiation

AdCP 3.2 splits structured proposal negotiation into `refine_proposals`. Existing `get_products` refinement remains the 3.x fallback, but its `budget_range` is a soft discovery filter. Do not copy it directly into `constraints.total_budget`, which is a hard commercial requirement.

## Buyer migration

Discover support before sending a 3.2-only request, then pass the advertised dimensions into both the workflow helper and the client call:

```ts
const support = extractProposalRefinementSupport(await agent.getCapabilities());
if (!support.supported) {
  // Use the legacy get_products refinement adapter described below.
}
if (!support.capabilities) {
  throw new Error('Seller omitted proposal_refinement capability details');
}

const negotiator = new ProposalNegotiator(
  request =>
    agent.refineProposals(request, undefined, {
      proposalRefinementCapabilities: support.capabilities,
    }),
  { capabilities: support.capabilities }
);
```

`extractProposalRefinementSupport()` accepts a raw `get_adcp_capabilities` response, the normalized value from `agent.getCapabilities()`, or a completed task/MCP wrapper. The SDK pins and requires the `adcp_version: '3.2'` and `adcp_major_version: 3` envelope, generates an idempotency key, rejects batches above 25, rejects alternatives above 10 or the seller's lower advertised ceiling, and rejects dimensions omitted from an explicit `supported_dimensions` declaration.

Pass the result through `unwrapVerifiedRefineProposals(result, request)` or use `ProposalNegotiator`. Verification covers result ordering, source lineage, JCS terms digests, alternative distinctness/count, typed constraints, product changes, and partial-result subsets. Task-level failures and intermediate states throw before success fields are exposed.

Exact transport retries reuse the same request and key. A changed refinement is a new intent and must use a fresh key; `ProposalNegotiator.changedRequest()` enforces that split. Check the committed proposal's `expires_at` immediately before `accept_proposal`/`buy_products`.

If `lifecycle_tools` omits `refine_proposals`, translate supported requests to the legacy `get_products({ buying_mode: 'refine', refine: [...] })` flow. Free-text `ask` maps to the legacy proposal ask. Product include/omit actions map directly. Hard constraints require explicit adapter policy: legacy discovery cannot guarantee the 3.2 hard-constraint semantics, so verify the returned proposal locally or report the dimension as unsupported.

When that fallback sends a proposal refinement with `action: 'finalize'`, it
remains a commit, as it was in 3.1, and now gains optional-key replay semantics.
SDK 14 clients attach an `idempotency_key`; reuse the identical request and key
for transport retries. SDK 14's server dispatcher caches a keyed finalize
variant before the proposal manager runs. A synchronous replay returns the
original committed proposal and inventory-hold expiry with `replayed: true`;
a HITL replay returns the same submitted task envelope, which the buyer polls
for completion. The compatibility schema permits older callers to omit the
key, but those calls have no cache-backed replay protection. A changed ask,
target, or constraint needs a fresh key.

## Seller migration

Declare support with `defineProposalRefinementCapabilities()` and register the handler as `proposalNegotiation` in the options passed to `createAdcpServerFromPlatform(platform, options)`. Registering this group automatically pins that server instance to the bundled AdCP 3.2 schema when `adcpVersion` is omitted; an explicit version below 3.2 is rejected at construction. This is the transitional 3.2 handler-group seam until proposal negotiation is promoted into the generated schema pin and `DecisioningPlatform`. Existing v5 handler-bag adopters may instead import `createAdcpServer` from `@adcp/sdk/server/legacy/v5`; do not start an otherwise platform-shaped integration on that deprecated constructor.

The server requires a trusted `resolveScope(ctx)` result and uses it for proposal lookup, persistence, and idempotency isolation; never derive tenant or principal scope from tool arguments. `createProposalRefinementHandler()` validates the complete 3.2/major-3 envelope, batch, and explicit dimensions before mutation, loads every source, calls the adopter's commercial evaluator, verifies the whole response, and only then opens a staging transaction. The evaluator owns pricing and concessions and must be side-effect-free; place inventory holds and other writes in the atomic transaction. The SDK does not choose business terms.

Use `createProposalSuccessor()` for immutable lineage and the normative `sha256:` base64url digest of RFC 8785 JCS `commercial_terms`. Store reads return an opaque source version; `begin(scope, expectedSources)` must compare-and-swap those versions, advance every source version, and insert successor IDs without overwrite in the same atomic commit. The transaction must stage invisibly. Any stage/commit error invokes rollback. A finalize batch that cannot create every hold must return only `unable` results (`hold_unavailable` for the failing entry, `batch_aborted` for eligible siblings) and perform no write.

See `examples/proposal-negotiation-buyer.ts` and `examples/proposal-negotiation-seller.ts`.
