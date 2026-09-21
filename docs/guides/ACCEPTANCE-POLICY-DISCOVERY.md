# Acceptance-policy discovery

Seller acceptance-policy discovery is advisory preflight guidance. It helps a
buyer understand likely seller treatment, but an exact seller task response is
always authoritative.

Use `resolveAcceptancePolicyCatalog()` for a one-shot fetch, or create a
capability-lifetime resolver when capabilities are retained:

```ts
import { createAcceptancePolicyCatalogResolver } from '@adcp/sdk';

const resolver = createAcceptancePolicyCatalogResolver();
const result = await resolver.resolve(
  capabilities.media_buy.acceptance_policy_discovery
);

if (!result.ok) {
  console.error(result.error.code, result.error.pointer);
} else {
  console.log(result.catalog.catalog_version, result.defaultProfiles);
}

// Also call this immediately on a capabilities-changed notification. Passing
// a changed capability to resolve() invalidates the old entry automatically.
resolver.invalidate();
```

Seller-local defaults have `resolution: 'resolved'` and include a verified
`profile`. Registry-backed defaults have `resolution: 'unresolved'` and expose
only their digest-pinned `ref`; they are not usable policy rules until a
trusted registry resolver fetches and verifies that exact profile. Treat an
unresolved or missing profile as unknown, never allowed. Use
`resolveAcceptancePolicyProfiles(catalog, product.acceptance_policy_profile_ids)`
to classify product-scoped profile IDs with the same explicit states.
This discovery slice does not evaluate rule `effective_at` or `expires_at`
windows; buyers must filter those windows before applying advisory guidance.

The resolver requires HTTPS without URL credentials, uses public-address DNS
pinning, refuses redirects, bounds wall time and response bytes, verifies the
SHA-256 digest over the exact response bytes before parsing, and validates the
document against the selected AdCP catalog schema. It also enforces the
schema's cross-list profile uniqueness, seller-profile canonical digests, and
local referential-integrity annotations. The response-body limit defaults to
1 MiB and cannot be raised above 1 MiB.

A digest mismatch is a hard failure. Callers must not evaluate or cache that
body as policy guidance. Error messages include schema pointers but never echo
catalog values.

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
canonical-profile failures so compliance output has equivalent meaning across
languages.
