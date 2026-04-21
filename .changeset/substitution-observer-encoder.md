---
'@adcp/client': minor
---

Add `SubstitutionObserver` + `SubstitutionEncoder` — paired runner-side
and seller-side primitives for the catalog-item macro substitution rule
(adcontextprotocol/adcp#2620) and its runtime conformance contract
(adcontextprotocol/adcp#2638, test-kit
`substitution-observer-runner`). Closes #696.

The library is available both at the root import and at the dedicated
`@adcp/client/substitution` subpath.

**Seller side** — produce RFC 3986-conformant encoded values from
raw catalog data:

```ts
import { SubstitutionEncoder } from '@adcp/client/substitution';

const encoder = new SubstitutionEncoder();
const safe = encoder.encode_for_url_context(rawCatalogValue);
const url = template.replace('{SKU}', safe);
// Optional defense-in-depth guard at catalog ingest:
encoder.reject_if_contains_macro(rawCatalogValue);
```

**Runner side** — observe a creative preview and grade substitution
per the test-kit contract:

```ts
import { SubstitutionObserver } from '@adcp/client/substitution';

const observer = new SubstitutionObserver();
const records = observer.parse_html(preview_html);
// (or)  const records = await observer.fetch_and_parse(url); // SSRF-policy-enforced
const matches = observer.match_bindings(records, template, [
  { macro: '{SKU}', vector_name: 'reserved-character-breakout' },
]);
for (const m of matches) {
  const r = observer.assert_rfc3986_safe(m);
  if (!r.ok) report(r); // { error_code, byte_offset, expected, observed }
}
```

Both surfaces share a single RFC 3986 implementation
(`encodeUnreserved`, `equalUnderHexCasePolicy`, `isUnreservedOnly`) so
one bug-fix path covers producer and verifier. The seven canonical
fixture vectors from
`static/test-vectors/catalog-macro-substitution.json` ship as
`CATALOG_MACRO_VECTORS` for reuse by storyboards and tests.

`enforceSsrfPolicy` / `enforceSsrfPolicyResolved` implement the
contract's normative deny list (IPv4 + IPv6 CIDRs, cloud metadata
hostnames, scheme allow-list, bare-IP-literal rejection in Verified
mode, DNS revalidation of every resolved address).

The observer additionally ships `assert_unreserved_only`,
`assert_no_nested_expansion`, and `assert_scheme_preserved` covering
the contract's stricter validations
(`rfc3986_unreserved_only_at_macro_position`,
`nested_expansion_not_re_scanned`, `url_scheme_preserved`).
