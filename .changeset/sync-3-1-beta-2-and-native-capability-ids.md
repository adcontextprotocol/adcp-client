---
'@adcp/sdk': minor
---

feat(v2): sync to 3.1.0-beta.2 + native `capability_ids` write path

The 3.1.0-beta.2 release closed two upstream issues the SDK had filed
during 7.10 development:

- **adcontextprotocol/adcp#4842 → #4844** added `capability_ids?: string[]`
  to `PackageRequest` (and an echo on `Package`). Buyers reading the V2
  mental model from `getProducts()` can now write `create_media_buy`
  packages V2-natively, with full normative resolution + `UNSUPPORTED_FEATURE`
  failure modes documented on the spec field.
- **adcontextprotocol/adcp#4862 → #4866** deprecated the never-provisioned
  `mirror.adcontextprotocol.org` host. `creative.adcontextprotocol.org`
  is now the single AAO trust anchor for `format_schema` `$ref` resolution.

### What's new in the SDK

- **`packageRefsForCapabilities(product, capabilityIds[])` — preferred V2
  write path.** Returns `{ capability_ids, format_ids }` ready to spread
  into a `PackageRequest`. Implements the spec's dual-emission convention
  (V2 buyers emit both so v2-capable sellers route by `capability_ids` and
  v1-only sellers — which ignore unknown fields via
  `additionalProperties: true` — fall back to `format_ids`).

  ```ts
  import { packageRefsForCapabilities } from '@adcp/sdk/v2/projection';

  const { data: { products } } = await agent.getProducts({ brief: '...' });
  const product = products[0];

  await agent.createMediaBuy({
    packages: [{
      package_id: 'pkg-1',
      product_id: product.product_id,
      pricing_option_id: product.pricing_options[0].pricing_option_id,
      ...packageRefsForCapabilities(product, ['nytimes_mrec', 'nytimes_video_30s']),
      budget: { currency: 'USD', total: 5000 },
    }],
  });
  ```

  Throws when any requested `capability_id` is missing on the product
  (matches the seller-side `UNSUPPORTED_FEATURE` rejection — we fail at
  compose-time rather than waiting for the seller). De-duplicates v1
  `format_ids` across declarations that share a ref.

- **Bridge helpers `@deprecated`.** `formatIdsFromOptions` /
  `tryFormatIdsFromOptions` / `formatIdsForCapability` remain exported
  indefinitely for callers writing strictly to v1 sellers or maintaining
  existing code, but new V2 work should use `packageRefsForCapabilities`
  for the dual-emission shape.

- **`DEFAULT_MIRROR_HOSTS` collapsed to a single anchor**
  (`creative.adcontextprotocol.org`). The legacy
  `mirror.adcontextprotocol.org` is no longer accepted as a `$ref` host
  — per adcp#4866 it was never provisioned and authorizing a ghost
  hostname is liability with no upside.

- **3.1.0-beta.2 schemas + types.** Sync scripts (`sync-schemas:3.1-beta`,
  `generate-types:3.1-beta`) bumped from beta.1 to beta.2. The opt-in
  type surface at `@adcp/sdk/types/v3-1-beta` now reflects beta.2
  (including the new `capability_ids` field on `PackageRequest` /
  `Package` plus all other beta.2 schema additions).

- **Projection loaders** (`canonical-properties.ts`, `registry.ts`) prefer
  `3.1.0-beta.2` over `3.1.0-beta.1` when both are present.

- **`COMPATIBLE_ADCP_VERSIONS`** list extended with `3.1.0-beta.2`.

### How to migrate

Existing 7.10 callers using `formatIdsFromOptions` keep working — the
helpers stay exported. The migration is opt-in:

```diff
- format_ids: formatIdsFromOptions(chosen),
+ ...packageRefsForCapabilities(product, [chosen.capability_id]),
```

The diff produces a richer request shape (v2 sellers prefer
`capability_ids`; v1 sellers still get `format_ids`) without changing
the seller-side behavior.

### Tests

- 6 new `packageRefsForCapabilities` cases (dual emission, v2-only
  declaration, missing capability throw, de-dup, empty input,
  spreadable into PackageRequest).
- Updated mirror-host test to reflect single-anchor default.
- 123/123 v2+projection+format-schema tests passing locally.
