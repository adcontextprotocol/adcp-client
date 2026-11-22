---
'@adcp/sdk': minor
---

Support the AdCP 3.3 `refine_proposals` additions: the experimental `extend_hold` action (`media_buy.hold_extension`), `include_collections` / `collections` (`media_buy.collection_cards`), and `expected_confirmation_at`.

- **Requests.** `validateRefineProposalsRequest` and `buildRefineProposalsRequest` accept `action: "extend_hold"` on AdCP 3.3. An entry carries only `proposal_id`, `action` and `ext`, and a batch with `extend_hold` contains only `extend_hold` entries. When the seller's capabilities are known, `media_buy.proposal_refinement.hold_extension` must be `true`; otherwise the action fails with `VALIDATION_ERROR`, as the spec requires of a seller that does not declare it. `include_collections` is accepted as a boolean on 3.3. On AdCP 3.2 both are refused, and unknown keys are still rejected. `createAdcpServer` runs the same validator, so a hand-written `refine_proposals` handler now receives these requests.
- **Responses.** A successful extension verifies like a finalize: one committed successor whose parent is the source, with a future `expires_at`, all-or-none across the batch. Under a 3.3 contract, `collections` is accepted on a completed response when the request set `include_collections` (each entry is checked against `core/response-collection.json`), and `expected_confirmation_at` on a submitted response. A 3.2 contract still rejects both.
- **Source checks.** `verifyHoldExtension(source, successor)` checks the successor against the committed source: same `terms_digest`, `hold_policy` and `hold_placed_at`, and a later `expires_at`. `ProposalNegotiator.extendHold(proposal)` sends the action and runs those checks.
- **Capabilities.** `ProposalRefinementCapabilities.hold_extension` is projected to AdCP 3.3 callers only, and `createAdcpServer` adds `media_buy.hold_extension` to `experimental_features` when it is declared, as the 3.3 schema requires.
- **Types.** `ExtendHoldProposalRefinement` joins the `ProposalRefinement` union. `RefineProposalsRequest.include_collections`, `RefineProposalsCompletedResponse.collections` and `RefineProposalsSubmittedResponse.expected_confirmation_at` are added.

`createProposalRefinementHandler` does not implement hold extension yet (#3600). It refuses `hold_extension: true` at construction and answers `extend_hold` with `VALIDATION_ERROR`; serve the action from a custom handler.
