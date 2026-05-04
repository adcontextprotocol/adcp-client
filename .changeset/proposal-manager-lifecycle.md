---
'@adcp/sdk': minor
---

**ProposalManager v1.5 dispatch wiring** — port of `adcp-client-python` PR #550. The framework now drives the full proposal lifecycle around the adopter's `DecisioningPlatform` + `ProposalManager`. Strictly additive on top of the v1 primitives shipped in the previous release.

**New runtime wiring** (in `runtime/from-platform.ts`):

- New `proposalStore?: ProposalStore` option on `createAdcpServerFromPlatform`. When supplied alongside `platform.proposalManager`, the framework drives all five lifecycle seams.
- `getProducts` shim: routes to `platform.proposalManager.getProducts` (or `refineProducts` when `buying_mode === 'refine'` and capabilities allow). Falls through to `sales.getProducts` when no manager is wired.
- `getProducts` finalize interception: detects `refine[i].action: 'finalize'` entries, calls the manager's `finalizeProposal`, commits the proposal via `proposalStore.commit`, and projects the wire response with `proposal_status: 'committed'` + `expires_at`.
- `getProducts` post-call: walks `proposals[]`, validates `overlap ⊆ wire`, persists each as a DRAFT record with typed recipes pulled from `Product.implementation_config`.
- `createMediaBuy` pre-call: when `proposal_id` is set, validates expiry + capability overlap, atomically reserves the proposal (`COMMITTED → CONSUMING`), and hydrates `ctx.recipes`. Two parallel `createMediaBuy(proposal_id=X)` calls cannot both reserve — the loser raises `PROPOSAL_NOT_COMMITTED`.
- `createMediaBuy` post-success: promotes `CONSUMING → CONSUMED` and records the `mediaBuyId` back-reference.
- `createMediaBuy` adapter throw: rolls back `CONSUMING → COMMITTED` so the buyer can retry.
- `updateMediaBuy` and `getMediaBuyDelivery`: hydrate `ctx.recipes` via the `getByMediaBuyId` reverse-index. Re-validates capability overlap on packages-shaped patches per Resolutions §5.

**New helpers exported from `@adcp/sdk/server`:**

- `enforceProposalExpiry`, `validateCapabilityOverlap`, `validateOverlapSubsetOfWire`, `detectFinalizeAction` — pure lifecycle validators.
- `maybeInterceptFinalize`, `maybePersistDraftAfterGetProducts`, `maybeReserveProposalForCreateMediaBuy`, `finalizeProposalConsumption`, `releaseProposalReservation`, `maybeHydrateRecipesForMediaBuyId` — dispatch-side helpers (also called internally by the runtime).
- `setProposalLifecycleLogger` — replace the module-level logger; tests use this to capture structured `proposal.draft_persisted` / `proposal.finalized` / `proposal.expired` / `proposal.consumed` events.

**`RequestContext.recipes`:** new optional `ReadonlyMap<string, Recipe>` field that the framework populates during proposal-mode dispatch. Adopter `createMediaBuy` / `updateMediaBuy` / `getMediaBuyDelivery` methods read `ctx.recipes` to apply per-product internal-config without re-fetching from the store. Undefined when no proposal-mode dispatch is wired.

**HITL finalize:** v1.5 ships *both* inline and HITL commit paths in this same release. `finalizeProposal` may return a `FinalizeProposalSuccess` directly (sync commit) OR a `TaskHandoff<FinalizeProposalSuccess>` (HITL slow path — framework wraps the handoff so `ProposalStore.commit` + `proposal.finalized` log with `path: 'handoff'` fire when the background task resolves). See the companion `proposal-manager-hitl-finalize` changeset for the HITL surface details. The earlier "deferred to v1.6+" rejection text in this changeset's draft was superseded — disregard.

**Spec-aligned error codes:** `PROPOSAL_NOT_COMMITTED` and `PROPOSAL_EXPIRED` are AdCP 3.0 GA. `PROPOSAL_NOT_FOUND` lands in 3.1; emitted today via the `(string & {})` non-standard path with `recovery: 'terminal'` (matches Python's `KNOWN_NON_SPEC_CODES` allowlist).
