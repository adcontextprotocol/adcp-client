# Collection fixture foundation

> **Who should read what.** Sections 1, 2 and 5 are for storyboard authors.
> Section 3 is SDK-internal rationale. Section 4 is for hosted and
> multi-tenant integrators, and its integration hold is a requirement, not
> optional hardening.

Five related additions to the storyboard runner, for storyboards that have to
pin a **real** collection-bearing product before they buy anything:

1. a bounded `collection_selection_satisfies` fixture predicate that qualifies
   candidates **before** deterministic selection;
2. declaration-local captures that publish the selected product, its scoped
   price and its collection witnesses from the **same** resolved graph;
3. a protected `__adcp_fixture_` context namespace with one atomic write
   funnel and detached snapshots;
4. `prepareStoryboardFixtures()` — reusable, immutable preparation state that
   both `runStoryboard` and `runStoryboardStep` accept;
5. `collection_set_equals_context` — namespace-aware set comparison through
   the same normalizer.

Everything here is additive. Storyboards that do not use the new declarations
behave exactly as before.

> **Upstream contract:** [adcontextprotocol/adcp#8259](https://github.com/adcontextprotocol/adcp/pull/8259).
> That packet is a proposal measured against SDK 15.9.5; the behavior
> described below is this SDK's implementation, re-verified on its own base.

---

## 1. Qualify before you select

The existing match DSL is closed, and `equals` is JSON deep equality. That is
a problem for `collection_targeting_allowed`, which **defaults to false when
omitted**: `equals: false` matches an explicit `false` and skips an omitted
flag that means exactly the same thing. Teaching every `equals` comparison to
apply schema defaults would silently rewrite the matcher contract, so the
default lives in one explicit predicate instead.

```yaml
fixture_resolution:
  products:
    - handle: fixed_bundle_product
      strategies: [discover]
      match:
        - path: '' # the whole candidate product
          operator: collection_selection_satisfies
          value:
            collection_targeting: fixed # literal false OR absent. `true` does not qualify.
            minimum_pairs: 1
```

| Operand | Values | Meaning |
| --- | --- | --- |
| `collection_targeting` | `fixed` | `collection_targeting_allowed` is literal `false` **or** absent. |
| | `selectable` | literal `true` only. |
| | `any` | either, as long as the flag is boolean or absent. |
| `minimum_pairs` | `1` (default) | one distinct concrete `(publisher_domain, collection_id)` pair. |
| | `2` | two distinct pairs — required before a strict subset exists. |
| `require_cross_publisher_collection` | `false` (default) / `true` | require a collection namespace outside every declared property namespace. |

A non-boolean flag never qualifies in any mode. That is a schema failure of
the seller's catalog — surfaced by response-schema validation during
discovery — not something the predicate repairs.

**Qualification runs before UTF-8 identity ordering.** A nonqualifying
earlier product cannot conceal a later qualifying one, and the full paginated,
schema-validated catalog is enumerated first. Discovery, schema, transport and
pagination errors stay terminal; a complete no-match is still an explicit
`fixture_unsatisfied` coverage gap, never a pass.

### Independent scopes

`minimum_pairs: 1` and `minimum_pairs: 2` qualify **independently**. A seller
whose only selectable product carries one collection still gets default
materialization coverage; the absence of a two-pair subset fixture does not
suppress it. Author them as separate declarations (or separate storyboards),
not as one declaration that needs both.

### Cross-publisher carriage

`require_cross_publisher_collection: true` looks for a collection selector
whose publisher domain is outside **every** `publisher_domain` declared
across `publisher_properties[]` **of that same product**. That is the whole
definition: it is structural, computed from one catalog row, with no network
I/O, no `adagents.json` fetch and no registry lookup. It does not mean the
collection intrinsically spans publishers, and it is not evidence of
beneficial ownership, AOR, rights-holder status, host authorization or a
verified supply path. A product declaring no property domains is ineligible
rather than vacuously qualifying. All selectors are traversed; index zero is not
special.

Only the singular `publisher_domain` form is read. `core/product.json`
restricts each entry with `{"not": {"required": ["publisher_domains"]}}` and
tells SDK implementers to enforce singular-only at runtime, so the compact
fan-out form is rejected on products. Honoring it would also cut the wrong
way: a larger host set makes the relation strictly harder to satisfy, which
would silently turn a non-conformant catalog into a coverage gap.

A product whose `collections[]` contains a domain-only bulk-grant entry does
not qualify at all. `core/product.json` requires `collection_ids` on every
entry, and accepting one would put a schema-invalid `{publisher_domain}`
selector into the witness bundle that storyboards substitute whole into
`collection_selection.collections`.

This establishes a **declared, wire-visible relationship**. It is not
verified beneficial ownership, not `adagents.json` host authorization, and not
a verified supply path. Keep assertions about those outside this predicate;
they need their own normative authority.

---

## 2. Captures from the same selected graph

Without captures, a storyboard that needs the selected product's collections
or pricing has two bad options: substitute literal authored values, or read
`products[0]` from another `get_products` call — which is a *different*
product with different selectors, a different currency and a different
minimum spend.

```yaml
fixture_resolution:
  products:
    - handle: selectable_product
      strategies: [discover]
      match:
        - { path: '', operator: collection_selection_satisfies, value: { collection_targeting: selectable, minimum_pairs: 2 } }
      context_outputs:
        - { key: __adcp_fixture_product_id, path: product_id }
        - { key: __adcp_fixture_bundle, witness: declared_selectors }
        - { key: __adcp_fixture_subset, witness: strict_subset }
        - { key: __adcp_fixture_unknown, witness: undeclared_collection_id_selectors }
        - { key: __adcp_fixture_foreign, witness: undeclared_publisher_domain_selectors }
  pricing_options:
    - handle: cpm_price
      product_handle: selectable_product
      strategies: [discover]
      match:
        - { path: /pricing_model, operator: equals, value: cpm }
      context_outputs:
        # `currency` is REQUIRED on cpm-option.json, so a path capture is safe.
        - { key: __adcp_fixture_currency, path: currency }
        # `fixed_price` and `min_spend_per_package` are OPTIONAL — capture the
        # whole option so a legal absence stays an absence. See below.
        - { key: __adcp_fixture_price, snapshot: selected_entity }
```

**Choose the form before you write the entry.** `path:` when the match
*guarantees* the field; `witness:` for derived collection state; `snapshot:`
when absence is legal and meaningful. A `path:` capture of an optional field
turns a conformant seller into a setup failure.

`path:` resolves against the **selected entity snapshot** — the product or
pricing option the resolver pinned. `witness:` binds a bounded derived value
from the `collection_selection_satisfies` evaluation of that same candidate.

| `witness` | Value |
| --- | --- |
| `declared_selectors` | the product's complete concrete selector array |
| `distinct_pairs` | normalized `(publisher_domain, collection_id)` pairs |
| `strict_subset` | one-entry selector array; a strict subset when ≥ 2 distinct pairs exist, else the capture fails |
| `undeclared_collection_id_selectors` | one-entry array with an id verified absent from the product |
| `undeclared_publisher_domain_selectors` | one-entry array with a domain verified absent from every namespace the product declares |
| `cross_publisher_relation` | `{ collection_publisher_domain, property_publisher_domains[], selector }`; requires `require_cross_publisher_collection: true`. `selector.publisher_domain` always equals `collection_publisher_domain`. |
| `property_publisher_domains` | declared property namespaces, bytewise ordered |

When `require_cross_publisher_collection: true`, `strict_subset` and both negative
witnesses are drawn from the **retained external owner**, not from whichever
pair sorts first. A bytewise-earlier local pair would otherwise produce a
subset that exercises only the host's own inventory while the storyboard
believed it was testing carriage. Two distinct *total* pairs still suffice —
one external pair alongside a local one is a legitimate carriage product.

Negative witnesses are **generated locally and collision-checked against the
complete selected product**, not hardcoded. A hardcoded "surely-absent" id can
be a real collection at some seller; a generated one is verified absent, and
is deterministic so evidence reproduces.

Three rules that make captures trustworthy:

- **All-or-nothing.** Nothing is published until the *whole* fixture graph
  resolves. A product that pinned but whose declared price did not leaves no
  captures behind.
- **A capture that cannot be built is a setup FAILURE** (`status: failed`),
  never an unsupported or unsatisfied downgrade. The author asked for state
  the selected entity does not provide; proceeding would grade the agent
  against a request nobody wrote.
- **Commercial terms come from the pinned graph.** `currency`,
  `fixed_price` and `min_spend_per_package` describe the option the buy will
  actually reference — so a 5 000 minimum is visible before the storyboard
  sends a 1 000 budget.
- **A capture is only as good as its match.** Captures read the entity the
  resolver pinned; they do not make a seller carry a field.

### Optional fields: use a snapshot, not a presence gate

`fixed_price` and `min_spend_per_package` are both OPTIONAL on
`cpm-option.json` — absent `fixed_price` means auction pricing, absent
`min_spend_per_package` means no minimum. A `path:` capture of either turns a
legal supporting seller into a setup failure. Gating the declaration on
`present` is worse: it stops that seller qualifying at all.

Capture the whole selected entity instead:

```yaml
context_outputs:
  - { key: __adcp_fixture_price, snapshot: selected_entity }
```

Absence then stays absence — the key is simply not on the captured object,
nothing is defaulted and no zero is fabricated.

```yaml
skip_if: '!context.__adcp_fixture_price.min_spend_per_package'
```

**That condition does not distinguish an explicit `0` from an absent field.**
Phase conditions support property lookup, truthiness, `!`, strict equality
against string/boolean literals, and `||` — there is no presence operator and
no numeric literal, so `0` and absent both take the same branch. The capture
preserves the difference; the condition grammar cannot express it. When the
difference matters, assert it on a validation (`field_value_or_absent`
against the response) rather than branching on it.

Use `path:` when the match *guarantees* the field (`product_id`, `currency`,
or a field you gated with a `present` predicate for a real eligibility
reason), and `snapshot:` when absence is legal and meaningful.

`path:` takes the dotted storyboard grammar (`currency`,
`pricing_options[0].rate`), not the RFC 6901 pointers `match[].path` takes —
a leading `/` is refused at load with a message naming the grammar. Every
dotted segment must name a field, so `"."`, `".."`, `"ext."`, `".ext"` and
`"a..b"` are refused too. `"."` in particular used to parse as two empty
segments, resolve to the whole selected entity and publish the entire
product snapshot under a scalar's key; if that is what you want, say so with
`snapshot: selected_entity`.

One authoring hazard worth naming: a whole-entity snapshot binds fields you
did not reason about. If a later validation compares a response field against
the snapshot, it is grading the seller against its own echoed catalog row —
self-consistency, not conformance. Compare against an authored expectation
when that is what you mean.

### Using a capture

Captures are ordinary whole-key `$context` substitutions:

```yaml
phases:
  - id: buy
    title: Buy
    steps:
      - id: create
        title: Buy the pinned offer
        task: create_media_buy
        stateful: true
        sample_request:
          brand: { domain: acmeoutdoor.example }
          start_time: asap
          end_time: '2099-06-30T23:59:59Z'
          currency: $context.__adcp_fixture_currency
          packages:
            # `cpm_price` is the authored handle; the runner rewrites it to the
            # pinned seller id. The product capture is shown to illustrate the
            # mechanism — the bare handle `selectable_product` works too.
            - product_id: $context.__adcp_fixture_product_id
              pricing_option_id: cpm_price
              budget: 25000
              targeting_overlay:
                collection_selection:
                  mode: selected
                  collections: $context.__adcp_fixture_subset
        validations:
          - check: field_present
            path: media_buy_id
            description: The buy succeeds
```

`declared_selectors`, `strict_subset` and both `undeclared_*` witnesses are
selector **arrays** and substitute directly into a `collections` field with
no transform. The other three are **diagnostic** shapes, not wire shapes:
`distinct_pairs` carries singular `collection_id` (not `collection_ids`),
`property_publisher_domains` is a `string[]`, and `cross_publisher_relation`
is a single object. Substituting `distinct_pairs` into `collections` passes
storyboard load and is rejected by the seller; feeding it to
`collection_set_equals_context` is caught with a named diagnostic rather
than diffed, because a missing `collection_ids` would otherwise read as a
domain-only bulk grant.

**`$context.<key>` matches a whole key only.** A snapshot can be *branched
on* in a phase condition, which does support dotted access, but it cannot be
*drilled into* for a request field:
`$context.__adcp_fixture_price.min_spend_per_package` in a `sample_request`
is not a supported substitution. The runner now reports it as an
`unresolved_substitution` rather than shipping the literal string, but the
fix is to capture the field with `path:` when you need it in a request —
which means gating it with a `present` predicate if it is optional, and
accepting that this narrows which sellers qualify.

### Parent/price coherence

When a product declaration has dependent pricing-option declarations, a
candidate product only qualifies if it carries at least one pricing option
those children could bind. Without this, the bytewise-first product can win
the parent selection and strand the graph on a child another product would
have satisfied.

---

## 3. The protected `__adcp_fixture_` namespace

Capture keys must start with `__adcp_fixture_` and match
`^__adcp_fixture_[A-Za-z0-9_]+$`, so existing whole-key `$context.<key>`
substitution resolves them with no new syntax.

Inside that namespace:

- Values are **committed once** and are immutable for the rest of the run —
  including to fixture preparation itself.
- Writes, deletes, provenance entries and unavailable-output markers all
  commit through one funnel that validates the **whole patch** before
  changing anything. A rejected patch lands nothing, including its ordinary
  keys.
- Metadata is guarded alongside values. Marking a prepared capture
  "unavailable" would suppress its consumer just as effectively as deleting
  it.
- Committed values are deep-cloned on ingestion and deep-frozen; every read
  for request building or diagnostics returns a detached clone. Guarding map
  assignment alone is not enough — `injectContext` hands out `context[key]`
  by reference, so a mutated request could otherwise write back into the
  snapshot it was built from.

Everything outside the namespace keeps its existing semantics exactly,
including by-reference injection of ordinary keys.

Rejected at **load time**: storyboard `context` defaults, step
`context_outputs` (path, `generate`, and `task_completion.` forms), and
duplicate capture keys across declarations. Rejected at **run time**:
`options.context`, routed `comply()` route context, convention extractors,
and seller responses. A runtime violation becomes a failed
`protected_context_violation` validation on the step that attempted it.

Seller opaque context is still **not** implicitly merged. The real promotion
paths are fixed convention extractors and authored `context_outputs`, and
both are now funnel-guarded.

---

## 4. Reusable preparation

```ts
import { prepareStoryboardFixtures, runStoryboardStep } from '@adcp/sdk/testing';

const prepared = await prepareStoryboardFixtures(agentUrl, storyboard, options);
if (prepared.disposition.status !== 'resolved') {
  // Terminal. Carried forward verbatim on reuse — a retry must not launder a
  // failed preparation into a freshly discovered alternative.
}

const step = await runStoryboardStep(agentUrl, storyboard, 'create', {
  ...options,
  prepared_fixtures: prepared,
  // REQUIRED for any reuse — see § Authority below. Omitting it fails
  // closed with zero seller calls.
  prepared_fixtures_authorizer: lookup => authorize(lookup),
});
```

`runStoryboard` accepts the same option and skips re-resolution.

The state exposes `binding`, `disposition`, `resolutions`, `coverageGaps`,
`selections`, `captures`, `captureProvenance`, `witnesses` and `phase`. Every
accessor returns a detached copy, including on a failed or no-match
preparation, and the objects handed to the constructor are cloned on
ingestion rather than retained. The fixture binding registry is deliberately
**not** on the public surface: it exposes live registration that could
re-point a pinned handle at a different seller entity.

### Binding

Prepared state is pinned to the storyboard content digest, the resolved
route(s), the schema artifact, the contract version, the resolved account
scope, the sandbox flag, a caller-declared nonsecret principal, a credential
fingerprint, and the run id. Everything except `run_id` is re-compared on
reuse.

The credential fingerprint is an HMAC under a **per-process random key**
covering *every* credential dimension: the whole `headers` map (not just
`Authorization` — the SDK documents `x-api-key` / `x-org-id` as the canonical
tenant-scoping example), run and per-route `auth`, and the test-kit API key.
Absence is an explicit sentinel rather than an omitted field, so "prepared
with no credential" cannot compare equal to "prepared with one". No bearer
token, OAuth token, API key or credential object is ever serialized into a
binding, a capture, evidence or an error; OAuth binds to the client id rather
than the rotating access token, so legitimate refresh does not break reuse.

Two limits worth stating. The **schema artifact digest** covers the bundle
tree's file inventory at the moment that root was first resolved in this
process; it detects a different resolved root (a `withExternalSchemaRoot`
scope, a version change) but NOT an in-place mutation of a root already
observed, and it is not a publisher-signed content digest. The **account
scope** comes from `resolveAccount`, which currently derives `operator` from
`brand.domain` — one dimension, not two — and unbranded runs share the SDK's
default brand. Neither field is a substitute for the authorizer.

`credential_fingerprint` covers the run credential and the routed per-agent
credential, and is re-compared on reuse. A step's own `auth` directive is
reported separately as `step_credential_fingerprint`, present only when the
step in scope declares its own `auth` — an absent value means the step
inherits the run credential, not that there is no step. It is not diffed:
preparation has no step, so diffing it would refuse every legitimate reuse.
Alongside it, `step_auth_kind` (`'none' | 'override'`) is the nonsecret
discriminator an authorizer can actually branch on; the fingerprint itself is
keyed per process, so it shows you *that* the credential differs, never what
it is. The authorizer can still refuse on it — the
`security_baseline` probes deliberately dispatch unauthenticated or with an
invalid key, and that is now visible before the wire call rather than after.

Both are HMACs over the *resolved* credential, not its syntax. Two runs
whose `auth: { type: 'api_key', from_test_kit: true }` directives are
byte-identical produce different fingerprints when the kit key differs, so a
rotated or swapped credential cannot reuse state prepared under the old
one.

### Authority — and what the SDK does not do

**The SDK does not implement a grant service.** Resolving a principal from a
session, storing grants and revoking them are host duties. What the SDK
guarantees:

- **No authorizer, no reuse.** Omitting `prepared_fixtures_authorizer` fails
  closed, for direct in-process state exactly as for an opaque reference,
  with zero seller calls. Trusted object identity proves a state came from
  `prepareStoryboardFixtures` in this process; it does not establish a
  current grant.
- **Every lookup is re-checked** — at run start and again before each step —
  for *both* forms. A decision made at preparation time is never cached
  forward, so a grant revoked after a successful step fails the next one.
- **The lookup carries the EFFECTIVE scope.** The account identity is read
  from the same `context.account` / `resolveAccount` the discovery call uses,
  so two accounts sharing a brand but differing by operator, unit or
  `account_id` produce different bindings. When the step's own
  `sample_request.account` authors an `account_id` or `operator` — which
  `resolveMediaBuyAccount` lets win over the context account — the binding
  reports it separately as `request_account_scope`, so `account_scope` is
  never the only account the authorizer is shown. The credential
  fingerprint folds in the step's own `auth` directive **and** the run's
  `test_kit.auth`, so a directive whose text is unchanged but whose
  `from_test_kit` resolution now yields a different credential still
  changes the fingerprint; a step that dispatches unauthenticated or with a
  deliberately invalid key is visible to the authorizer *before* the wire
  call rather than after.
- **The authorizer runs BEFORE binding coherence**, and a refusal names only
  the binding *fields* that differ, never their values. Diffing first would
  answer an unauthorized caller's guessed reference with a report describing
  another principal's routes, account and credential fingerprint — and turn
  that fingerprint into a credential-confirmation oracle.
- **Authorization precedes any seller contact at all** — before clients are
  constructed and before capability discovery, not merely before the
  mutating calls. True for `runStoryboard`, `runStoryboardStep` and
  `prepareStoryboardFixtures`. `comply()` is **not** a reuse entry point and
  refuses `prepared_fixtures` outright with zero seller contact: prepared
  state binds one storyboard digest, and comply picks its storyboard set
  from its own capability discovery, so there is no scope to authorize
  against before the agent is reached. Call `prepareStoryboardFixtures()`
  and pass the state per storyboard. The binding needs no seller input, so there is no reason
  for an unauthorized caller to reach the agent's discovery endpoint, let
  alone the `comply_test_controller` reset and `seed_*` mutations that
  normally run before the first phase.
- **Trust is runtime object identity.** A `structuredClone`, a JSON
  round-trip, a hand-built look-alike with the right public shape, a
  prototype-only object, a sealed reference, a `context_provenance` map, a
  principal string in caller JSON, and a seller-authored authorization
  boolean all fail `isTrustedPreparedFixtures`. The class value is exported
  for `instanceof`, but its constructor requires a module-private token, so
  `new PreparedStoryboardFixtures(...)` from caller code throws rather than
  minting trusted state — `@internal` on a constructor is documentation, not
  access control.
- **A malformed decision is never consent.** Authorization requires
  literally `{ authorized: true }`. `undefined`, `null`, `{}`,
  `{ authorized: 'yes' }`, `{ authorized: 1 }`, a thrown error, a rejected
  promise and an `authorized` getter that throws all refuse, with zero
  seller calls. The host's error text is never echoed into the result —
  a grant store's connection string is not a compliance finding.
- **Opaque references fail closed without an authorizer.** The SDK has no
  session and no grant store; refusing is the only honest answer.
- **Every reference-shaped refusal reads the same.** Not-found, untrusted,
  wrong contract version and your-authorizer-said-no all answer
  `prepared fixture state was refused by the configured authorizer` with
  `actual: authorizer_denied` and an identical validation shape, and the
  authorizer is consulted (answer discarded) even on the not-found path so
  the call count matches. Your own `detail` is not echoed back on this
  path — a denial that reads "not yours" would otherwise confirm the
  reference existed. Direct state keeps its specific codes: that caller
  already holds the object and learns nothing from them.
  **This is not a constant-time guarantee.** The resolving path does more
  work (it clones the prepared binding and reads your decision), and your
  own resolver's lookup time is not something the SDK can bound, so a
  patient attacker with many samples can still separate the two by timing.
  If your threat model includes that, pad inside your resolver.

  **If you are the legitimate operator and you hit this**, the SDK cannot
  tell you which arm fired — but your own authorizer can. It is called on
  every path, including not-found (where its answer is discarded), so log
  the `PreparedFixturesLookup` it received. If it was never called at all,
  the refusal is `authorizer_required`. And if you hold the state object,
  pass it directly rather than by reference: the direct form keeps
  `untrusted_state`, `contract_version_mismatch` and `binding_mismatch`
  with their differing-field lists.

  One thing the uniformity does **not** cover: the authorizer is handed
  the stored binding on a resolving reference and a second copy of
  `current` on a missing one, so an authorizer that deep-compares them can
  tell the two apart. That is not a leak — the authorizer is the host, and
  the store it would be learning about is its own. What is closed is the
  oracle available to the caller, who sees only the refusal.
- **A refusal is an access-control error, not a grading outcome.** When a
  gate refuses, `runStoryboard` / `runStoryboardStep` **throw**
  `PreparedFixturesDeniedError` and return nothing. The error carries
  `refusalCode` — one of `authorizer_required`, `untrusted_state`,
  `contract_version_mismatch`, `authorizer_denied`, `binding_mismatch`,
  `unauthorized_metadata` — and nothing else: no grading result, partial
  or redacted, and so no fixture identities, `seller_ids`, captures,
  binding values, request/response records, or results from steps that
  ran before the grant was revoked. A hosted route should surface it as a
  403-style denial.

  ```ts
  import { PreparedFixturesDeniedError } from '@adcp/sdk/testing';

  try {
    return await runStoryboardStep(agentUrl, storyboard, stepId, options);
  } catch (error) {
    if (error instanceof PreparedFixturesDeniedError) {
      return res.status(403).json({ error: 'forbidden', refusal_code: error.refusalCode });
    }
    throw error;
  }
  ```

- **The evidence still has to exist somewhere accountable.** The runner
  builds the COMPLETE, unredacted record first — the synthesized
  `prepared_fixtures_authorization` check, `fixture_resolutions` with
  `seller_ids`, exact request and response records for every step that
  ran, the reserved captures — and hands it to
  `prepared_fixtures_audit_sink` before throwing. That is an authorized
  scope inside your trust boundary; it must not be routed back to the
  refused caller. Configure no sink and the record is simply not produced
  to anyone. A sink that throws does not change the outcome: the denial
  is thrown either way, and the sink's own failure is never reported to
  the caller, since that would be an oracle over host state.

  In that retained record the refusal check uses explicit `request: null`,
  `response: null`, `json_pointer: null` and `duration_ms: 0`. Explicit,
  not omitted — a missing key cannot be told apart from a runner that
  forgot to record one.

  **There is no `[redacted]` projection of a refused run any more.** An
  earlier design returned a redacted report to the refused caller; the
  contract now forbids both halves of that — no result for the caller,
  and no marker standing in for required evidence in the record. Nothing
  in the SDK redacts on the refusal path.

```ts
await runStoryboardStep(agentUrl, storyboard, stepId, {
  ...options,
  // `withPreparedFixtures` makes the pair atomic: the authorizer is
  // REQUIRED, and passing the two fields separately lets you forget it
  // until the run refuses. The raw fields still work.
  ...withPreparedFixtures({ ref, resolve: ref => hostStore.get(ref) }, async ({ binding, current, step_id, reference }) => {
    // Resolve principal/tenant/run from TRUSTED SERVER SESSION STATE, never
    // from the request body. Re-check grant, revocation and expiry, and
    // re-check effective per-step credential scope after routing/auth
    // overrides.
    const grant = await grants.lookupLive(session.tenantId, reference);
    if (!grant || grant.revoked) return { authorized: false, detail: 'grant revoked' };
    if (grant.accountScope !== current.account_scope) return { authorized: false, detail: 'account mismatch' };

    // The ONLY meaningful credential comparison is within `current`. Both
    // fingerprints are HMACs under a per-process key, so a value you
    // persisted from an earlier process is not comparable — but a step whose
    // effective credential differs from the run's is visible here, before
    // the wire call. `step_auth_kind` is the nonsecret discriminator.
    if (current.step_auth_kind && !grant.allowsProbeSteps) {
      return { authorized: false, detail: `step overrides the run credential (${current.step_auth_kind})` };
    }
    return { authorized: true };
  }),
});
```

`runStoryboardStep` executes a named step **without** evaluating its
enclosing `phase.skip_if` — so a storyboard that branches on a snapshot the
way § 2 shows will run the step anyway on this path. See *What this does not
solve*.

Your authorizer's `detail` is echoed to the caller on the **direct-state**
form only, never on the reference form. If you reuse one denial string for
both, keep it free of anything you would not show an unauthorized caller.

### Process scope — an explicit limit, not an oversight

Prepared state is **process-local**. Its trust is a live object identity and
its credential fingerprint is keyed by a per-process random key, so it does
not survive serialization and is not meant to. A frozen JSON snapshot that
crossed a process boundary carries no evidence that its grant is still live.

Durable, multi-process or cross-host reuse needs either authenticated
reconstruction (run `prepareStoryboardFixtures` again under the authenticated
scope) or a host-side reference lookup that re-checks live scope on every
use. Accepting a rehydrated snapshot is not an option the SDK offers.

### Integration hold

`prepared_fixtures_authorizer` is a **required integration point for hosted
multi-tenant callers**, not an optional hardening step. Without it, the SDK
enforces binding coherence only — which observes a reroute, an account
switch, a schema swap or a credential change, but **cannot observe
revocation**. That gap is the host's to close. Shipping a hosted step route
that forwards prepared state without an authorizer is an unenforced
authorization boundary, and this SDK does not claim otherwise.

There is no warn-only path: reuse without an authorizer is refused, not
degraded. A single-tenant CLI run that genuinely has no grant model should
call `runStoryboard` without `prepared_fixtures` at all, or supply an
authorizer that returns `{ authorized: true }` as an explicit, reviewable
decision rather than an omission.

---

## 5. `collection_set_equals_context`

```yaml
validations:
  - check: collection_set_equals_context
    path: packages[0].targeting_overlay.collection_selection.collections
    context_key: __adcp_fixture_subset
    description: The readback restates exactly the collections we selected
```

Both sides are normalized to atomic `(publisher_domain, collection_id)` pairs
and compared as exact sets after bytewise pair ordering. Outer grouping and
inner id order are irrelevant; namespaces never are.

- IDs are never flattened without their domain — two publishers may declare
  the same `collection_id`.
- Schema-valid redundancy (a repeated id, an overlapping pair split across
  two groups) collapses to one pair. `product.collections[]` and
  `collection_ids[]` carry no uniqueness constraint, so redundancy is legal
  *product composition*.
- The readback arm is stricter: `core/collection-selection.json` declares
  `uniqueItems: true` on `collections` in `mode: selected`. Normalizing here
  is for COMPARISON only and never excuses that — ordinary response-schema
  validation is what rejects a duplicated outer entry, and this check does
  not replace it.
- Empty-string ids are legal and preserved — the schema declares no
  `minLength`. Nothing is case-folded, trimmed or punycoded. Unicode
  identifiers are byte-exact.
- The domain-only bulk-grant selector (`{ publisher_domain }` with no
  `collection_ids`) is a **distinct** selector, not an empty enumeration, and
  does not count toward `minimum_pairs`.
- Distinct pair cardinality defines a proper subset.

Failure modes have distinct diagnostics: `expected_context_absent`,
`expected_context_malformed`, `actual_collections_malformed`, or a set
difference listing missing and unexpected pairs. Normalization is bounded at
`COLLECTION_PAIR_LIMIT` (10 000) distinct pairs and diagnostics at
`COLLECTION_DIAGNOSTIC_LIMIT` (20) rendered pairs; exceeding the pair bound is
a **visible failure**, never truncation that could make unequal sets compare
equal.

**Unlike the branch-safe `field_equals_context` family, a missing
`context_key` fails.** A mandatory set comparison that passes when its
expected state was never captured certifies exactly the substitution it
exists to catch.

The validator runs through the shared per-step engine, so `runStoryboard` and
`runStoryboardStep` grade it identically.

---

## Upstream amendment this depends on

**Six** new names are not yet in the published AdCP contracts:

| Name | Section that must list it |
| --- | --- |
| `collection_selection_satisfies` | `storyboard-schema.yaml` — closed match-operator set |
| `fixture_resolution[].context_outputs` | `storyboard-schema.yaml` — `fixture_resolution` grammar |
| `collection_set_equals_context` | `runner-output-contract.yaml` — `authored_check_kinds` |
| `fixture_capture_unbuildable` | `runner-output-contract.yaml` — runner-SYNTHESIZED check kinds |
| `protected_context_violation` | `runner-output-contract.yaml` — runner-SYNTHESIZED check kinds |
| `prepared_fixtures_authorization` | `runner-output-contract.yaml` — runner-SYNTHESIZED check kinds |

Four further amendment items are not new *names* but are normative, and a
third-party runner cannot infer them:

| Item | Why the contract must state it |
| --- | --- |
| The reserved `__adcp_fixture_` prefix, and the `__proto__` / `constructor` / `prototype` rejection | An authoring constraint on **every** storyboard's `context`, `context_outputs[].key` and `not_applicable_if[].context_keys` — not only ones using this feature. Without it a third-party author has no way to learn the prefix is reserved, and a third-party runner accepts what this one rejects at load. |
| A carve-out from the `context_key_absent` family rule | `runner-output-contract.yaml` note #2 mandates `passed: true` + `observations:` when a named context key is absent. `collection_set_equals_context` deliberately **fails** instead, because fixture captures publish all-or-nothing so absence means the graph never resolved — not a skipped branch. A runner implementing the family rule verbatim would certify exactly the substitution the check exists to catch. |
| `path: ''` as the whole-candidate-entity pointer | Every existing match operator targets a sub-path; a third-party runner could reasonably reject an empty pointer. |
| The second parent-selection exclusion | `storyboard-schema.yaml` pins deterministic selection as "exclude candidates already pinned to non-reusable handles, sort by UTF-8 bytewise seller identity, select the first" — one exclusion. Skipping a parent that cannot satisfy a dependent discover-only pricing spec is a second, and it changes which product a conformant seller is tested on. |

`collection_set` and `minimum_pairs` are zero-occurrence in
`schemas/cache/3.2.6/` — they are SDK-local storyboard DSL, not wire
objects, and the amendment should say so or a reader will take
`collection_set_equals_context` to assert a wire shape.

The last three check kinds matter because the contract closes the synthesized side too
(`capture_path_not_resolvable | unresolved_substitution`), and a report
consumer keying on that enum will see three unknown values. The amendment
also needs the per-kind `expected` / `json_pointer` / `request` / `response`
grammar for them, not just the name lists.

Until a companion `adcontextprotocol/adcp` PR lands all six, no *published*
storyboard can legally use any of this. That is a merge dependency, not an
implementation gap — and it is why the downgrade story below matters.

### Output inventory for the amendment

Everything a report consumer can newly observe, with where it is emitted and
what the surrounding fields carry.

**Eight runner-SYNTHESIZED emission sites, plus one AUTHORED validator that
is counted separately.** The authored kind is not a synthesized site and
must not be folded into that total — it belongs in the contract's
`authored_check_kinds`, never in its closed synthesized list.

Line numbers rot; these find the sites in any revision.

| Group | Count | Find them with |
| --- | --- | --- |
| synthesized — capture | 3 | `grep -n "check: 'fixture_capture_unbuildable'" src/lib/testing/storyboard/{seeding,runner}.ts` — the seed/discovery step, the funnel's own commit refusal, and a standalone step reusing a failed preparation |
| synthesized — protection | 2 | `grep -n "check: 'protected_context_violation'" src/lib/testing/storyboard/runner.ts` — the shared graded-commit helper (covering four funnel call sites) and the ordinary step's context patch |
| synthesized — authority | 3 | `grep -n "check: 'prepared_fixtures_authorization'" src/lib/testing/storyboard/runner.ts` — the per-step gate, the run and pass gates, and the standalone step entry gate |
| **authored — separate** | 1 | `grep -n "collection_set_equals_context" src/lib/testing/storyboard/validations.ts` — dispatch and implementation |

`schema_id` and `schema_url` are `required_on_failure` for every check and
MUST be `null` outside `response_schema`, so all four kinds carry them as
explicit nulls. Omitting the keys is not the same as recording `null`: a
consumer cannot tell "no schema applies" from "the runner forgot".

`json_pointer` is `null` on `protected_context_violation` and
`prepared_fixtures_authorization`: neither is anchored to a location in a
seller response, and inventing a pointer would make a setup failure look
like a response defect. `fixture_capture_unbuildable` is the exception —
when the failure is a declared `path:` that did not resolve, it carries the
RFC 6901 form of that path, matching what the contract requires of its
analogue `capture_path_not_resolvable`. It stays `null` for the witness and
size/depth arms, which genuinely have no path.

| Check kind | Emitted from | `passed` | `json_pointer` | `expected` | `actual` | Wire evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `fixture_capture_unbuildable` | the `seed_*` / discovery step of the synthetic fixture-resolution phase, when a declared capture cannot be built from the pinned entity | always `false` | RFC 6901 form of the failing `path:`, else `null` | `a value at the declared selected-entity path, or a derivable witness` | `null` | yes — the VALIDATION itself carries the `get_products` or `comply_test_controller` exchange that produced the entity. This is a post-wire failure, so an explicit null would misreport it as no contact. When discovery paginated, the recorded exchange is the page that actually carried the pinned product; `page_count` and `cursors` in the resolution evidence disclose that there were more |
| `fixture_capture_unbuildable` | a synthetic `__fixture_capture__` step, when the protected funnel refuses the commit itself (freezability / extensibility — rules the pre-check does not model) | always `false` | `null` | `a capture the runner can deep-clone and freeze` | comma-joined refused key names | no — `duration_ms: 0`, no request/response; `task` is derived from the refused capture's own provenance |
| `fixture_capture_unbuildable` | a `runStoryboardStep` result when the prepared state's own disposition is `failed` | always `false` | `null` | `a fixture graph that resolved during preparation` | `preparation_failed` | no — `duration_ms: 0`; the preparation already happened |
| `protected_context_violation` | any of the five funnel commit sites, via one shared graded helper — prepared-capture hydration, both creative-probe context commits, the `not_applicable_if` availability gate, and the ordinary step's context patch | always `false` | `null` | `no write, delete or metadata change to the __adcp_fixture_ namespace` | comma-joined offending key names | depends on the site; the ordinary step carries its own exchange, the others are `duration_ms: 0` |
| `prepared_fixtures_authorization` | the run-start gate (`runStoryboard`), the per-pass gate, and every per-step gate | always `false` (an authorized lookup emits nothing) | `null` | `an authorized prepared state bound to this exact run scope` (run/pass) or `… to this exact step scope` (step) | one refusal code, below | no — `duration_ms: 0`; the gate precedes all seller contact including capability discovery |

`prepared_fixtures_authorization.actual` is a closed set of six:

| `actual` | Meaning |
| --- | --- |
| `authorizer_required` | reuse was requested with no `prepared_fixtures_authorizer`. Applies to DIRECT state as well as to an opaque reference. |
| `untrusted_state` | direct state that `prepareStoryboardFixtures` did not produce in this process (rehydrated, cloned, or a look-alike). |
| `contract_version_mismatch` | direct state whose `contract_version` is not this runner's. |
| `authorizer_denied` | the host authorizer refused. Also the answer for **every** pre-authorization failure on a reference, so the refusal cannot be used as an existence oracle. |
| `binding_mismatch` | authorized, but the binding does not match the current scope. `detail` names differing FIELDS only, never their values. |
| `unauthorized_metadata` | caller-supplied `context`, `context_provenance` or `response_derived_not_applicable_context_keys` carried a reserved or prototype-sensitive key. Screened before any seller contact. |

The lookup payload (`PreparedFixturesLookup`) carries `binding` (as
prepared), `current` (as observed now), `gate`, and — when applicable —
`step_id` and `reference`. Both bindings are separately deep-cloned on every
path, including refusals. Diffed binding fields are `storyboard_id`,
`storyboard_digest`, `agent_urls`, `agent_route_fingerprint`,
`schema_artifact`, `contract_version`, `account_scope`, `brand_scope`,
`sandbox`, `principal` and `credential_fingerprint`. `run_id`,
`step_credential_fingerprint`, `step_auth_kind` and `request_account_scope`
are reported but NOT diffed — they are per-step or per-preparation by
nature, and a diffed per-step field would refuse every step.

Two notes a renderer needs:

- The refusal **sentence** is uniform for every reference-shaped lookup —
  `prepared fixture state was refused by the configured authorizer`. The
  host's own `detail` is deliberately not echoed there, because a message
  that varies with whether the reference resolved is an existence oracle.
  Direct state keeps its specific text; that caller already holds the object.
- `unauthorized_metadata` is also the spelling of one
  `ProtectedContextViolationCode`. The two never collide in output:
  `protected_context_violation` puts offending KEY names in `actual`, never
  a code.

**Skip semantics changed.** `fixture_unsatisfied` is now a canonical
`RunnerSkipReason`, so an unsatisfied prepared state reports
`skip_reason: fixture_unsatisfied` **and** `skip.reason: fixture_unsatisfied`.
It was previously a detailed reason mapped down to `not_applicable`, which
bucketed a fixture coverage gap with genuine applicability gates — the exact
distinction the contract's reason list exists to preserve. Both of the
runner's unsatisfied paths now spell it the same way.

The `fixture_unsatisfied` **detail** is the contract's exact form —
`fixture_unsatisfied: <fixture_type>:<handle>, …`, with pricing options as
`pricing_option:<product_handle>/<handle>` — and names every unsatisfied
fixture, not just the first.

## Downgrade behavior on an older runner

Author the **declaration**, not just the validator name.

A runner without this contract rejects
`fixture_resolution.products[].context_outputs` and the
`collection_selection_satisfies` operator at **load time** — fail-closed.

A new *validator name* alone is not safe: unknown check kinds grade
`passed: true, not_applicable: true` by forward-compatibility contract, so a
storyboard carrying only `collection_set_equals_context` would be silently
undergraded by an older runner rather than failing.

---

## What this does not solve

Stated plainly, because a foundation that over-claims is worse than one with
documented edges:

- **Enclosing `phase.skip_if` in standalone execution.** `runStoryboardStep`
  still executes a named step without evaluating its phase condition.
  Preparation parity is not conditional-flow parity; restoring fixture
  identities does not fix phase orchestration.
- **Two children needing two distinct pricing options on one product.**
  Parent/price coherence is an existence check and deliberately
  claim-blind; if the chosen parent carries only one qualifying option, the
  second child strands with a visible diagnostic rather than reselecting.
- **Native feature-qualified offer binding for brief-only or empty-catalog
  declarations.** Preparation pins entities that exist in a catalog. A
  declaration-driven route is separate, WG-unratified work.
- **Ownership and host authorization.** The carriage relation is a declared
  wire relationship only.
- **Reporting obligations.** Top-K selection from an unobserved population,
  strict ISO `committed_at` filtering, per-metric measurability, and
  absent-ledger current-catalog fallback are downstream source concerns.
- **Caller branding.** Request enrichment still uses `options.brand` /
  `brand_manifest`, defaulting to `test.example`. `comply()` has one
  run-level brand; heterogeneous suites need explicit caller orchestration.
  Brand authority is never derived from captured seller metadata.
- **Hosted accounting.** How a raw discovery failure is classified by a
  hosted disposition layer is an accounting-owner question; this change
  alters no accounting or floors.
