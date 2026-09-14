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
  task: 'control_media_buy', // this example requires a live entry declaring control_media_buy
  now: Date.now(),
});
if (preflight.ok) {
  // Submit the complete request using the existing client's controlMediaBuy.
  // Retain the idempotency key after an ambiguous timeout and settle async tasks.
}
```

`assessProductAction` and `assessProposalAction` are independently usable during
discovery and negotiation. `assessActionAvailability` reads the accepted proposal
on the live buy, or `options.proposal` when the accepted snapshot is stored separately.
Both paths use the same decomposition. A separately supplied snapshot must carry
accepted status and a matching MediaBuy ID or current accepted proposal ID; missing
join evidence remains unknown. An embedded
snapshot takes precedence. An unaccepted proposal cannot authorize the live buy. Product templates
are advisory; a positive template cannot create or expand an accepted right.
The discovered product remains advisory even when an accepted buy has a different
negotiated right. It never overrides current execution authority.

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
absence denotes the established `update_media_buy` default. Task-discriminated
entries require a compatible seller-emitted canonical task. A legacy entry that
omits `task` uses `update_media_buy`, including task-less 3.2 response/echo shapes. Task alternatives come
from the pinned canonical action metadata. A mode does not choose a route:
`seller_managed` can use control or refinement when the action supports that task,
and follows ordinary submitted/working/completed task handling. There is no new
MediaBuy approval status or disclosed seller approval workflow.

The existing `preflightUpdateMediaBuy` gains portable checks when a current
accepted snapshot with explicit change terms is supplied. Its old `valid_actions`
compatibility path remains available for recognized mutations. Every path rejects
unmapped sibling fields and honors explicit live scope and task restrictions. Use `preflightMediaBuyActions` for strict
new adoption: all decomposed actions must pass before sending the whole mutation.
When package totals change, each affected package requires its own increase or
decrease right. A known net-zero transfer uses `reallocate_budget`; an unknown
baseline cannot establish reallocation. Budget bounds apply to each affected
budget or cap, matching the protocol reference seller, and never authorize a
currency change. Result bounds remain unknown when opaque `new_packages` budgets
cannot be accounted for. An add-only request with a package budget, daily cap, or
spend floor also stays unknown: a package-count right alone does not establish
the new monetary commitment. Mixed requests must share one executable task; the explicit
`update_media_buy` compatibility facade can subsume compact routes atomically,
including targeting plus assignment replacement and accepted rights whose only
compact route is `refine_proposals`. The facade retains the negotiated mode and
bounds; it does not turn seller-managed work into immediate execution. Sellers
implementing a compact handler must pass that handler's task explicitly. Mismatched compact tasks are
rejected. `preflightUpdateMediaBuy` defaults to the facade. The route-neutral
`preflightMediaBuyActions` requires an explicit `task: 'update_media_buy'` for
a mixed-route request, and its denial explains that remedy. Each assessment
retains the advertised compact route even when the attempted route is the facade.
Unmapped mutation
fields fail closed. These helpers assess patches and do not validate a full wire
request: callers must retain schema validation and the required revision and
idempotency envelope at dispatch. The legacy helper throws `ValidationError`
for an unmapped/no-op request and returns `denials`; the strict helper returns
`ok: false` with `assessments` and a message for that case.
A task-less entry uses only the documented `update_media_buy` default: refetch
`get_media_buys` for canonical routing metadata rather than inferring that the
seller accepts the same patch at a different endpoint.

A stale request revision returns a local `CONFLICT` diagnostic. On a server
`ACTION_NOT_ALLOWED` race, use `refreshMediaBuyActions(buy, error.details)` to
replace the action set, including an empty set. Absent optional echoes leave the
snapshot unchanged; malformed echoes throw. Echoes are copied deeply. This does not change the buy's
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
The rc.3 shared-frequency-cap action and `applicable_package_ids` are supported
without copying unrelated schema-adoption changes. Seller emission defaults to
the SDK pin; supply `adcpVersion: '3.2.0-rc.3'` (or a newer served version) to
emit these fields. Older target versions receive an unavailable diagnostic. Package scope requires every
requested package to belong to the emitted set; it never authorizes a buy-wide
mutation. Without the requested packages, assessment remains unknown.

`update_name` is a noncommercial metadata action and cannot be a change term.
Its explicit current structured entry provides `authority: 'live_metadata'`
without a `term`; commercial actions return `authority: 'accepted_term'`.
Legacy flat hints never establish this metadata authority.

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
  // Optional explicit current seller policy, distinct from advisory discovery:
  productPolicy: currentProductRestrictions,
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

The accepted terms remain the ceiling. Optional `productPolicy` explicitly applies
current seller restrictions across every affected product; discovery templates
are not treated as current policy by default. These policy declarations intersect;
a right on one package cannot authorize sibling packages. Seller decisions may
omit actions, select compatible tasks, or shorten SLA maxima. They cannot replace
mode, drop committed maxima, expand status scope, or broaden typed bounds.
Materialization validates term/action uniqueness, status/mode/SLA shape, compatible
constraint kinds and currencies, consistent bounds, and every product template.
The original accepted data is preserved; callback inputs and output terms are
copies. Optional `request` returns separate `request_assessments`; it does not
filter the full `available_actions` projection that is returned to clients. `now`
evaluates current absolute effective-time gates. Notice and requested-change
bounds remain on the advertised right and are evaluated against an actual
request, never against a fabricated empty patch. Terminal statuses project an empty array.
The optional seller `metadata.update_name` decision explicitly enables naming
changes under the same three gates, without fabricating a commercial term.
`decide` may provide an rc.3 `applicable_package_ids` narrowing; the seller must
supply all affected product declarations for that scope.

`wireVersion: '3.1'` deliberately projects supported rights to opaque `terms_ref`
and maps `seller_managed` to the legacy `requires_approval` spelling. Current 3.2
output carries `change_term_id`; `emitTermsRefAlias: true` adds an equal legacy
alias. Commercial rights always originate in accepted terms. Rights that cannot be
represented safely by the legacy vocabulary or package scope are omitted with a
diagnostic. The default 3.2 output is the canonical MediaBuy action shape for
`get_media_buys` and `control_media_buy`, not the narrower legacy update response
or `ACTION_NOT_ALLOWED` echo schema.

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

The seller assertion defaults to its named `update_media_buy` route. Pass
`{ task: 'control_media_buy' }` in a control handler (and the exact served
`adcpVersion` when it differs from the SDK pin). Patch previews never dispatch
mutations or infer the handler's transport.

Every preflight path refuses `invoice_recipient` and opaque vendor `ext`
(including new-package extensions)
parameters because they can change behavior without a portable action mapping.
Package `context`, like root `context`, is inert correlation data. Callback
`push_notification_config` belongs to the operation envelope; it does not
change persistent reporting configuration. Cancellation siblings are all checked
on this strict path; it does not silently discard requested mutations. Full wire
validation remains required (for example, inline `creatives` needs a nonempty
array, while clearing `creative_assignments` requires `remove_creative`).

The published ACTION_NOT_ALLOWED details vocabulary is narrower than canonical
actions. When an attempted canonical action cannot be represented, the assertion
keeps the error code and message but omits details. This is a known conflict
between the manifest requirement to populate details and the pinned schema
that cannot represent those canonical actions; emitting an invalid enum or
inventing an action identity would be incorrect. When only the action
echo cannot be represented, it omits that optional echo. Buyers then re-read
`get_media_buys`; the SDK never fabricates a rollup identity or a partial current
action list.
