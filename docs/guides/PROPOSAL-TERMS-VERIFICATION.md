# Verify proposal terms before acceptance

Use the standalone buyer API to compare a seller's proposal with the **complete
commercial terms the buyer reviewed**. The existing root exports remain available.

```ts
import {
  verifyProposalCommercialTerms,
  assertProposalCommercialTerms,
  type ProposalCommercialTermsMismatch,
} from '@adcp/sdk/negotiation/verification';

const result = verifyProposalCommercialTerms(proposal, reviewedCommercialTerms, {
  adcpVersion: sellerAdcpVersion, // seller-served release; defaults to the SDK schema pin
});
if (!result.ok) {
  for (const mismatch of result.mismatches) {
    console.error(mismatch.kind, mismatch.path, mismatch.message);
  }
  // Stop acceptance, including when result.truncated is true.
} else {
  // Continue the buyer's status, expiry, governance, and acceptance checks.
}

// Alternatively, throws ProposalCommercialTermsVerificationError on failure.
assertProposalCommercialTerms(proposal, reviewedCommercialTerms, {
  adcpVersion: sellerAdcpVersion,
});
```

This is a synchronous, tree-shakeable **Node.js** entry point with ESM and CJS
declarations. It loads local schema bundles and uses Node crypto. It neither
constructs a protocol client nor contacts an agent or a contract URL. Browser
applications should perform this verification in their buyer backend; this entry
does not bundle Node polyfills or a browser schema store.

## Verification order and mismatch paths

The verifier first bounds the supplied JSON tree, then verifies `terms_digest`
against `sha256:` plus base64url SHA-256 of RFC 8785 JCS `commercial_terms`.
A digest failure returns only `digest_mismatch` at `/terms_digest`, before reading
the selected schema or the expected terms. This checks content integrity; a
matching digest by itself does not mean the buyer agreed to the contents.

Both complete snapshots must satisfy the same schema. The comparison includes
every admitted value recursively: price, currency, aggregate and purchase flights,
purchases, budgets, change rights, status scope, service modes, SLA, opaque
conditions, contract pointers, and nested extension data. Object key order is
irrelevant. Array order and the difference between absence and presence remain
binding. Schema errors return `invalid_terms` with the affected subject; comparisons
return `missing`, `unexpected`, or `changed` with RFC 6901 JSON Pointers such as
`/commercial_terms/purchases/0/pricing/fixed_price`. Pointers escape `/` as `~1`
and `~` as `~0`. Diagnostics omit field values and are bounded; paths preserve
property names. Schema-support failures identify the affected schema location.

Package IDs assigned during execution are outside the commercial envelope. The
canonical schema uses ordered `purchases`; the verifier does not silently turn a
legacy `packages` array into purchases. Narrative, allocation, and display fields
outside `commercial_terms` cannot substitute for the reviewed snapshot.

## Runtime schema coupling and additions

The comparison shape comes from the selected bundle's
`media-buy/commercial-terms.json` and its references, including `patternProperties`
and open extension objects. There is no SDK binding-field list. A new optional
field requires both an installed matching schema and an explicitly reviewed
snapshot containing that field; otherwise verification fails. An equal unknown
field outside the selected schema fails too. Never build the expected snapshot by
blindly copying the unreviewed candidate.

For binding snapshots, enum values must be listed in the selected schema even
when taxonomy annotations advertise extensibility. `x-extensible` and `x-pattern`
do not relax this conservative pre-acceptance policy; changed annotations require
review. An unknown industry value therefore needs an updated matching enum bundle.

Unknown schema keywords, a different schema dialect, cross-bundle references, and
changed `x-adcp-validation` contracts return `unsupported_schema`, even for equal
snapshots. The reviewed semantic annotations in
`src/lib/negotiation/commercial-terms-semantics.ts` are deliberately separate from
the runtime field shape. Explanatory `description` and `spec` metadata may change;
normative rule values, including prose inside `verifier_constraints`, require
review. Historical omissions are recorded in release-scoped semantic profiles.
On a schema upgrade, audit new annotations and implement
any required pre-acceptance behavior before updating that semantic support record.
Pricing integrity and portable change-term consistency checks run before the diff.
Schema-selected checks also reject contradictory place/region targeting, place
labels without a matching identifier, malformed language tags, and timezones
absent from the runtime's IANA database where the schema declares that check.
Bare string fields such as `budget_cap_timezone` receive only their schema-declared
validation. These checks run only on the applicable schema
branch; an `inventory_local` daypart remains valid. These specialized validators
are cached separately from ordinary SDK schema validators.
Preserving an opaque condition or contract pointer does not evaluate that
condition, resolve the contract, or grant permission to execute an action.

Pass the seller-served release. Full prerelease pins remain exact; release-precision
pins such as `3.2-rc.2` resolve to their installed bundle. Stable patch selection
follows the SDK loader's minor-line compatibility rules. `schemaVersion` records
the actual selected release. Missing bundles return `schema_unavailable`. There is
no network fallback, downgrade, field stripping, or automatic version projection.
External roots must retain the reviewed semantic graph. Canonical root-relative
schema IDs work, as do `latest` IDs when a matching root `index.json` pins the release.
Schema documents and support audits are cached together with validator state.
Treat an active schema root as immutable; registering a replacement root or
restarting the application refreshes all three. Timezone and language checks
use the runtime's ICU data; Python implementations should test against their
supported locale and timezone databases as well as the portable fixtures.
Use the same module format for external-root registration and verification:
the SDK's ESM and CJS module graphs maintain separate loader state.
The bundle must have unambiguous schema identities throughout its registered
documents; identical published mirrors are allowed, conflicting definitions fail closed.

The reviewed rc.3 semantic profile removes the direct `buy_products` offer-matching
annotation from product purchases while retaining accepted-snapshot preservation
and pricing identity. That change is scoped to the exact rc.3 release; it does not
weaken the rc.2 contract or automatically approve future annotation changes.

The released `3.2.0-beta.8` bundle has commercial terms but no `change_terms`;
it rejects that later field. The pinned 3.1 bundle has no canonical commercial
envelope and returns `schema_unavailable`. Existing 3.1 action readers continue
to treat `available_actions[].terms_ref` as opaque. A proposal's
`change_terms[].terms_ref` is a contract reference and may differ from `term_id`.
Only a live 3.2 action carrying `change_term_id` and its compatibility `terms_ref`
alias has an equality obligation. Joining those actions to accepted terms belongs
to Part A of [#2664](https://github.com/adcontextprotocol/adcp-client/issues/2664);
this pre-acceptance API does not infer that join or grant authority from a legacy
pointer that happens to resemble a term ID.

## Upstream coordination and Python parity

The initial Part B implementation landed in SDK
[#2757](https://github.com/adcontextprotocol/adcp-client/pull/2757). Upstream
[`adcp#6794`](https://github.com/adcontextprotocol/adcp/pull/6794), implementing RFC
[#6750](https://github.com/adcontextprotocol/adcp/issues/6750), temporarily patched
the installed SDK's `dist/lib/negotiation/verification.{js,mjs}` allowlist in
`scripts/overlay-compliance-cache.sh` to admit `change_terms`.

That coordination is already complete:
[`adcp#7018`](https://github.com/adcontextprotocol/adcp/pull/7018) upgraded to
`@adcp/sdk@14.0.0-beta.16`, deleted the overlay, and switched storyboard runs to
public `schemaRoot`/`complianceDir` options. Current upstream pins SDK rc.35.
No companion patch-removal PR remains necessary. When upstream consumes this
hardening, update its SDK pin and lockfile together and run `test:sdk-shims` plus
the current and frozen compatibility storyboard matrices; do not restore a dist
patch to bypass an unsupported semantic contract.

Python tracking remains
[`adcp-client-python#1067`](https://github.com/adcontextprotocol/adcp-client-python/issues/1067).
Parity requires digest-first rejection, complete schema-admitted comparison,
ordered-array behavior, precise escaped pointers, failure on unreviewed schema
semantics, and the same absence/opaque-reference/version behavior. The fixtures
under `test/fixtures/proposal-commercial-terms` are portable JSON. Part A's unified
action assessment and seller resolver remain separate work.
