# Assess and resolve MediaBuy change rights

Use `assessMediaBuyAction` to render product possibility, a proposal promise, and
current execution availability without joining protocol objects yourself. The pure
`@adcp/sdk/media-buy/actions` entry point supports browsers, ESM, and CommonJS.
The same buyer helpers are exported from the SDK root.

```ts
import { assessMediaBuyAction, preflightMediaBuyActions } from '@adcp/sdk/media-buy/actions';

const assessment = assessMediaBuyAction({
  action: 'increase_budget',
  product,
  buy: currentBuy, // includes the seller's current accepted_proposal snapshot
  request: { total_budget: { amount: 11000, currency: 'USD' } },
});
// possibility: possible / unsupported / unknown; always binding: false
// promise: promised (with the complete term) / not_negotiated / unknown
// availability: available_now / currently_unavailable

const request = {
  revision: currentBuy.revision,
  idempotency_key: persistedOperationKey,
  total_budget: { amount: 11000, currency: 'USD' },
};
const preflight = preflightMediaBuyActions(currentBuy, request, {
  task: 'control_media_buy',
  now: Date.now(),
});
if (preflight.ok) {
  // Submit the complete request using the existing client's controlMediaBuy.
  // Retain the idempotency key after an ambiguous timeout and settle async tasks.
}
```

`assessProductAction` and `assessProposalAction` are independently usable during
discovery and negotiation. `assessActionAvailability` reads the accepted proposal
on the live buy. A separate unaccepted `proposal` passed to the unified call can
supply the promise display, but cannot authorize the live buy. Product templates
are advisory; a positive template cannot create or expand an accepted right.
An explicit product denial can narrow current availability.

Before accepting any proposal, run
[`verifyProposalCommercialTerms`](./PROPOSAL-TERMS-VERIFICATION.md) in the buyer
backend against the complete independently reviewed commercial snapshot and the
seller-served schema version. Digest verification and complete binding-field
comparison remain that verifier's responsibility. This pure action helper does
not replace verification, account authorization, governance, expiry checks, or
the seller's atomic revision/idempotency boundary.

## Reasons, uncertainty, and routing

`currently_unavailable.reason` uses the existing preflight/protocol vocabulary:
`wrong_status`, `not_supported_on_product`, `not_supported_on_buy`, `mode_mismatch`,
and `condition_unresolved`. `certainty` distinguishes a known blocker from missing
information. The whole absence of `change_terms` yields
`compat: { reason: 'no_change_terms', message }`; an explicit empty array means no
negotiated rights. A missing live action can reflect a temporary seller restriction.
The accepted promise remains visible even when status or current policy blocks it.

A promised term exposes its mode, status scope, SLA, constraints, opaque conditions,
contract reference, and display description. Condition identifiers and descriptions
are never executed or interpreted. Seller-only conditions remain unknown to buyers,
even when a seller has separately resolved them. Portable constraints also remain
unknown without the needed request, committed baseline, currency, or current time.
Known exceeded bounds carry `code: 'REQUOTE_REQUIRED'`, a constraint name, and a
request path. Calendar/campaign durations cannot be converted without additional
seller state. A changed flight timestamp is not a scheduled mutation time: current
mutation schemas have no future `effective_at`, so a positive notice requirement
cannot be satisfied by an immediate mutation.

`MediaBuyTask` is the narrow union `update_media_buy | control_media_buy |
refine_proposals | sync_creatives`. `nonDefaultRoute` carries the non-default task;
absence denotes the established `update_media_buy` default. Modern executable
entries require a compatible seller-emitted canonical task. Task alternatives come
from the pinned canonical action metadata. A mode does not choose a route:
`seller_managed` can use control or refinement when the action supports that task,
and follows ordinary submitted/working/completed task handling. There is no new
MediaBuy approval status or disclosed seller approval workflow.

The existing `preflightUpdateMediaBuy` gains portable checks when a current
accepted snapshot with explicit change terms is supplied. Its old `valid_actions`
compatibility path remains available. Use `preflightMediaBuyActions` for strict
new adoption: all decomposed actions must pass before sending the whole mutation.
Package budget increases and decreases cannot hide behind a net total change.

A stale request revision returns a local `CONFLICT` diagnostic. On a server
`ACTION_NOT_ALLOWED` race, use `refreshMediaBuyActions(buy, error.details)` to
replace the action set, including an empty set. This does not change the buy's
revision or accepted proposal. Re-read current state after a conflict, reassess,
and follow the existing lifecycle coordinator's retry rules; never automatically
mint a new idempotency key after an ambiguous mutation.

## Version compatibility

AdCP 3.1.19 `available_actions[].terms_ref` is always opaque. Even a string equal
to a known `term_id` grants no identity or authority. Supply `adcpVersion` when
reading a historical seller. The released `3.2.0-beta.8` bundle has no change terms
and receives the same unknown compatibility result. Legacy `valid_actions` remains
readable through `getAvailableActions`; it is a hint without a known mode or term.
An explicitly empty structured `available_actions` array takes precedence over a
stale flat array.

Modern actions join through `change_term_id`. Set `termsRefIsAlias: true` only
when the 3.2 producer deliberately emits both fields as aliases; equality then
becomes mandatory. Without that declaration, an independent opaque `terms_ref`
remains opaque. A proposal term's own `terms_ref` is a contract-document reference
and may always differ from its `term_id`. No helper fetches that reference.
The rc.3 shared-frequency-cap action is supported without copying unrelated
schema-adoption changes into this feature.

## Seller builder

`mediaBuyActionResolver` is exported alongside `validActionsForStatus` from
`@adcp/sdk/server` and the root. It has two operations:

```ts
import { mediaBuyActionResolver } from '@adcp/sdk/server';

const changeTerms = mediaBuyActionResolver.materialize({
  products: allAffectedProducts,
  acceptedTerms: sellerSelectedBindingTerms,
  sellerAccepted: true, // required at runtime, including for JavaScript callers
  currency: 'USD',
});
// Persist these terms in the proposal; buyer acceptance and digest binding use
// the existing proposal lifecycle. Materialization itself does not accept a buy.

const projection = mediaBuyActionResolver.resolve({
  buy: currentSellerSnapshot,
  products: allAffectedProducts,
  decide: term => ({
    authorization: accountAuthorizationFor(term),
    governance: verifiedGovernanceAllows(term),
    policy: sellerPolicyAllows(term),
    conditionsSatisfied: sellerConditionsSatisfied(term),
  }),
});
// Return projection.available_actions on the live MediaBuy.
```

Each gate must explicitly return true. Missing or unknown results do not admit an
action. The seller owns authentication, signed delegation verification, field
scopes, account isolation, and loading the currently accepted snapshot. Never
copy these gate values from buyer parameters. Call under the existing mutation
transaction and revision/idempotency safeguards. The builder performs no I/O.

The accepted terms remain the ceiling. All affected product declarations intersect;
a right on one package cannot authorize sibling packages. Seller decisions may
omit actions, select compatible tasks, or shorten SLA maxima. They cannot replace
mode, drop committed maxima, expand status scope, or broaden typed bounds.
Materialization validates term/action uniqueness, status/mode/SLA shape, compatible
constraint kinds and currencies, consistent bounds, and every product template.
The original accepted data is preserved; callback inputs and output terms are
copies. `request` and `now` optionally enforce portable request bounds during
seller resolution. Terminal statuses project an empty array.

`wireVersion: '3.1'` deliberately projects supported rights to opaque `terms_ref`
and maps `seller_managed` to the legacy `requires_approval` spelling. Current 3.2
output carries `change_term_id`; `emitTermsRefAlias: true` adds an equal legacy
alias. Neither projection adds a right absent from accepted terms.

## Python parity and compliance

Track parity in [adcp-client-python#1067](https://github.com/adcontextprotocol/adcp-client-python/issues/1067).
Both implementations must retain absent-vs-empty semantics; opaque 3.1 pointers;
explicit 3.2 alias declarations; identical denial reasons and uncertainty; task
routing independent of mode; complete mixed-action checks; portable constraint
and duration semantics; independently evaluated seller gates; intersection across
products; immutable accepted terms; and action-echo replacement without revision
or proposal substitution.

The package includes the matching bundle's
`media_buy_seller/change_rights_state_projection` and
`media_buy_seller/compact_product_lifecycle` compliance storyboards. Run these with
the SDK storyboard runner against a sandbox seller, with controller seeding enabled.
The tests also cover their stateful SDK-server execution and public package imports.
