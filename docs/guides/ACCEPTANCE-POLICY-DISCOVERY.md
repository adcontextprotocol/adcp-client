# Acceptance-policy discovery

Seller acceptance-policy discovery is advisory preflight guidance. It helps a
buyer understand likely seller treatment, but an exact seller task response is
always authoritative.

Use `resolveAcceptancePolicyCatalog()` for a one-shot fetch, or create a
capability-lifetime resolver when capabilities are retained:

```ts
import { createAcceptancePolicyCatalogResolver, RegistryClient } from '@adcp/sdk';

const registry = new RegistryClient();
const resolver = createAcceptancePolicyCatalogResolver({
  registryResolver: registry,
});
const result = await resolver.resolve(
  capabilities.media_buy.acceptance_policy_discovery
);

if (!result.ok) {
  console.error(result.error.code, result.error.pointer);
} else {
  console.log(result.catalog.catalog_version, result.defaultProfiles);
  for (const issue of result.issues ?? []) {
    console.warn(issue.code, issue.pointer);
  }
}

// Also call this immediately on a capabilities-changed notification. Passing
// a changed capability to resolve() invalidates the old entry automatically.
resolver.invalidate();
```

Seller-local defaults have `resolution: 'resolved'` and include a verified
`profile`. When `registryResolver` is configured, registry-backed defaults are
resolved at their exact policy version and become usable only after both the
policy's canonical digest and embedded profile digest match the catalog pins.
Without a registry resolver they have `resolution: 'unresolved'` and expose
only their digest-pinned `ref`. Treat an unresolved or missing profile as
unknown, never allowed. Use
`resolveAcceptancePolicyProfiles(catalog, product.acceptance_policy_profile_ids)`
to classify product-scoped profile IDs without network access. To fetch and
verify selected registry-backed product profiles, use
`resolveVerifiedAcceptancePolicyProfiles(catalog, profileIds, { registryResolver: registry })`.
Pass only the `catalog` returned by a successful catalog resolver; the helper
checks internal integrity but cannot independently attest a catalog obtained
from an unpinned side channel. A failed registry lookup or pin verification is
reported in `issues` and leaves that profile `unresolved`; it does not discard
verified seller-local profiles.
Use the assessment helper below to apply rule `effective_at` and `expires_at`
windows before acting on advisory guidance.

Registry resolution has one five-second deadline across the selected profiles
and resolves at most 32 distinct registry profiles per call. Both limits may be
lowered with `timeoutMs` and `maxRegistryProfiles` on the product helper, or
`registryTimeoutMs` and `maxRegistryProfiles` on the catalog resolver; they
cannot be raised above 30 seconds and 32 profiles. Split unusually large
product selections into separate calls and keep treating a timeout or
incomplete batch as unknown.

Registry policy IDs and versions originate in the seller catalog. The resolver
passes those identifiers to the configured registry, which may attach registry
credentials. Configure only a registry you intend sellers to query and avoid
credentials with broader scope than policy resolution. Registry failures are
cached as unresolved for the capability lifetime to prevent retry fan-out.
Accordingly, diagnostics returned by the capability-lifetime resolver set
`retryable: false`: call `invalidate()` before retrying after registry recovery,
which also refetches and re-verifies the catalog. The standalone product helper
and one-shot catalog resolver do not retain results and report transient
registry failures as retryable.
Verified registry content is immutable by digest, but a later registry
withdrawal is observed only after a capability change or `invalidate()`.

The resolver requires HTTPS without URL credentials, uses public-address DNS
pinning, refuses redirects, bounds wall time and response bytes, verifies the
SHA-256 digest over the exact response bytes before parsing, and validates the
document against the selected AdCP catalog schema. It also enforces the
schema's cross-list profile uniqueness, seller-profile canonical digests, and
local referential-integrity annotations. The response-body limit defaults to
1 MiB and cannot be raised above 1 MiB.

A catalog digest mismatch is a hard failure. Callers must not evaluate or cache
that body as policy guidance. A registry policy or profile digest mismatch
leaves only that registry profile unresolved and appears in `issues`; its rules
must not be evaluated. Error messages include schema pointers but never echo
catalog values.

## Assess likely treatment

Compose the verified seller defaults with product-specific profiles and assess
one decision surface with structured buyer facts:

```ts
import {
  assessAcceptancePolicy,
  resolveVerifiedAcceptancePolicyProfiles,
} from '@adcp/sdk';

if (!result.ok) {
  throw new Error(`Acceptance policy is unknown: ${result.error.code}`);
}
const productProfiles = await resolveVerifiedAcceptancePolicyProfiles(
  result.catalog,
  product.acceptance_policy_profile_ids ?? [],
  { registryResolver: registry }
);
if (!productProfiles.ok) {
  throw new Error(`Acceptance policy is unknown: ${productProfiles.error.code}`);
}
for (const issue of [...(result.issues ?? []), ...(productProfiles.issues ?? [])]) {
  console.warn(issue.code, issue.pointer);
}

const assessment = assessAcceptancePolicy({
  profiles: [
    ...result.defaultProfiles,
    ...productProfiles.profiles,
  ],
  acceptanceContext: {
    subjects: [{
      subject_category: 'political_advertising',
      subject_facets: ['candidate_or_party'],
    }],
    advertiser_roles: ['political_actor'],
    delivery_jurisdictions: ['US'],
  },
  appliesTo: 'media_buy',
});

if (assessment.outcome === 'prohibited') {
  // Do not submit this configuration.
} else if (assessment.outcome === 'unknown') {
  // Ask the seller or submit the exact task and handle its authoritative result.
} else {
  console.log(assessment.outcome, assessment.matchedRules);
}
```

The normalized `outcome` is `allowed`, `prohibited`,
`requires_disclosure`, `requires_setup`, `requires_review`, or `unknown`.
An explicit matching prohibition wins. Otherwise, partial coverage,
unresolved profiles, omitted matching facts, or a complete profile whose scope
does not cover the full contemplated request produces `unknown`. Conditional
requirements—and requirements attached to any other matching disposition—are
returned intact and grouped conservatively. Authorization, funding, unknown,
or content/targeting restrictions require review; advertiser credentials and
account prerequisites require setup; only known declaration, disclosure, and
transparency obligations produce `requires_disclosure`. Each `matchedRules`
entry retains its profile, rule, policy IDs, disposition, and requirements.
When the outcome is `unknown`, returned requirements are partial evidence only,
not a complete remediation plan.

The evaluator independently validates the context and every resolved profile
against `adcpVersion` (the SDK pin by default). Pass the same version used for
resolution; invalid profiles produce `invalid_profile` and fail closed.

Rules become active at `effective_at` and inactive at `expires_at`. The helper
uses the current instant unless `evaluatedAt` is supplied. It interprets only
typed fields; every free-text `description` remains display-only.

The assessment is always marked `advisory: true`. Even `allowed` means only
that the verified, published complete profiles allow the contemplated class of
action. The seller's response to the exact task remains authoritative.

The resolver cache contains only one capability identity. A URL, digest, or
default-profile change discards the previous entry. Call `invalidate()` when a
capabilities-changed notification arrives even if the replacement capability
has not been fetched yet.

## Cross-SDK parity

The Python SDK implementation must use the same HTTPS/credential, DNS-pinning,
redirect, timeout, byte-limit, exact-byte digest, schema, semantic-integrity,
and capability-lifetime cache rules. Diagnostic names should distinguish
invalid options, unsafe URL, fetch, digest, unavailable/invalid schema,
invalid catalog documents, duplicate or unresolved references, and
canonical-profile failures. Registry diagnostics must distinguish fetch,
timeout, unresolved reference, policy/profile identity, unverifiable content,
digest, schema/integrity, and resolution-limit failures so compliance output
has equivalent meaning across languages.

Assessment parity requires the same six outcomes and precedence:
`prohibited` > `unknown` > `requires_review` > `requires_setup` >
`requires_disclosure` > `allowed`. Requirement buckets are:

- disclosure: `category_declaration`, `disclosure`, `transparency_reporting`;
- setup: `advertiser_verification`, `advertiser_eligibility`, `certification`,
  `license`, `account_setup`;
- review: `funding_restriction`, `prior_authorization`, `sales_assisted`, every
  targeting/creative/destination/format/time restriction, `custom`, and any
  requirement kind the SDK does not recognize.

Assessment diagnostics distinguish unresolved, conflicting, invalid, or
oversized profile selections; partial coverage; incomplete or invalid context;
invalid evaluation time; an unavailable schema; and oversized rule,
context-value, or JSON-complexity inputs. Diagnostics are bounded, and missing
information never produces `allowed`.
