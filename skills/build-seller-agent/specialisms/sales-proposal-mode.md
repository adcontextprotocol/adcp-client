# Specialism: sales-proposal-mode

Companion to [`../SKILL.md`](../SKILL.md). The SKILL.md baseline applies; this file covers only the deltas for `sales-proposal-mode`.


Storyboard: `media_buy_proposal_mode`. The acceptance path inverts the baseline — buyer sends `proposal_id` + `total_budget`, no `packages`.

`get_products` returns a `proposals[]` array alongside products:

```typescript
return {
  products: PRODUCTS,
  proposals: [
    {
      proposal_id: 'balanced_reach_q2',
      name: 'Balanced Reach Plan',
      rationale: 'CTV for premium reach, OLV for sports frequency, display for always-on context.',
      total_budget: { amount: 50000, currency: 'USD' },
      budget_allocations: [
        { product_id: 'ctv_outdoor_lifestyle', pricing_option_id: 'ctv_cpm', amount: 25000, currency: 'USD' },
        { product_id: 'olv_sports', pricing_option_id: 'olv_cpm', amount: 15000, currency: 'USD' },
        { product_id: 'display_endemic', pricing_option_id: 'display_cpm', amount: 10000, currency: 'USD' },
      ],
      forecast: { impressions: 3_500_000, reach: 1_200_000, frequency: 2.9 },
    },
  ],
  sandbox: true,
};
```

Handle `buying_mode: 'refine'` by returning an updated `proposals[]` plus `refinement_applied[]` describing what changed.

`create_media_buy` with `proposal_id`:

```typescript
createMediaBuy: async (params, ctx) => {
  if (params.proposal_id) {
    const proposal = PROPOSALS[params.proposal_id];
    if (!proposal) return adcpError('INVALID_REQUEST', { message: `Unknown proposal_id: ${params.proposal_id}` });
    // TTL check — return PROPOSAL_EXPIRED if the proposal has aged out
    return {
      media_buy_id: `mb_${randomUUID()}`,
      status: 'active' as const,       // instant on proposal accept
      proposal_id: proposal.proposal_id,
      packages: proposal.budget_allocations.map((a, i) => ({ /* expand server-side */ })),
    };
  }
  // ... fall through to baseline packages path
},
```

