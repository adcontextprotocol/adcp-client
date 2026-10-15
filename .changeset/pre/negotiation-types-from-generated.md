---
'@adcp/sdk': patch
---

Derive the negotiation `CanonicalProposal` and `ProposalPurchase` types from the generated wire types, so fields the pinned AdCP schemas add reach them without hand edits.

- `CanonicalProposal` now extends the generated `CanonicalProposal`, re-declaring only `commercial_terms` (still generic over the terms type) and `insertion_order` (still accepts the legacy open object). Once the pinned schemas include AdCP 3.3's experimental proposal hold fields, `hold_policy` and `hold_placed_at` appear on it automatically.
- `ProposalPurchase` now extends the generated `ProductPurchase`, re-declaring only `pricing` (still optional and still accepts `ProposalResolvedPricing`).
- On the current pin, both types have the same fields with the same types and optionality as before. Runtime behaviour is unchanged.
