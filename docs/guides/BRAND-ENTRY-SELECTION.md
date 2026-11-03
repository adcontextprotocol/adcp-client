# Selecting a complete brand entry

The registry can return the complete resolved brand entry as `ResolvedBrand.brand`. It retains brand.json's field shapes, including locale-keyed names and taglines, the fonts object, colors, and tone. It comes from the same winning identity source as the rest of that response. The existing `brand_manifest` field remains available with its existing meaning.

```typescript
import { RegistryClient } from '@adcp/sdk';

const registry = new RegistryClient();
const resolved = await registry.lookupBrand('spark.example');
const entry = resolved?.brand;
if (entry) {
  console.log(entry.names, entry.fonts, entry.tone);
}
```

Older registry deployments can omit this field. It is also absent when the selected source cannot supply a unique, complete entry. Absence is not permission to choose the first brand in a portfolio or to mix an entry from a different source with the selected response's metadata.

For a cached registry response, helper output must also agree with the registry's established brand identity. The registry can omit `brand` when its existing identity and the document's unique match disagree. Use an independently established portfolio `brandId` when available, and retain absence when identity agreement cannot be established.

For a document that you independently fetched or cached, use the pure helper:

```typescript
import { selectBrandEntry } from '@adcp/sdk/brand';

const cachedDocument = {
  house: { domain: 'nova-brands.example', name: 'Nova Brands' },
  brands: [
    { id: 'glow', names: [{ en: 'Glow' }] },
    {
      id: 'spark',
      names: [{ en: 'Spark' }],
      properties: [{ type: 'website', identifier: 'spark.example' }],
    },
  ],
};

const entry = selectBrandEntry(cachedDocument, 'spark.example');
const byId = selectBrandEntry(cachedDocument, {
  domain: 'nova-brands.example',
  brandId: 'spark',
});
```

The helper is also exported from `@adcp/sdk` and `@adcp/sdk/client`.

Selection rules match the registry's entry projection:

- A canonical `id` + `names` document supplies the brand document itself.
- A known `brandId` selects that unique inline portfolio entry; it is an ID, not a display name.
- Otherwise an entry must uniquely match the requested hostname through its homepage URL or an owned website property. The canonical brand.json field is `relationship`, with an omitted relationship defaulting to `owned`; `direct`, `delegated`, and `ad_network` properties do not select identity. A supplied `delegation_type` compatibility field also prevents an owned-property match, even alongside `relationship: 'owned'`.
- On the house's own hostname, a unique `master` is the default. A sole inline brand may supply the default only when no pointer brands exist. Other hostnames do not inherit this default. `houseDomains` admits only extra hostnames you have already confirmed through the protocol's permitted HTTPS normalization path.
- Missing/ambiguous entries, pointer-only documents, redirects, and agent-only documents return `undefined`. There is no first-entry fallback.

The function performs no fetching, schema validation, or ownership verification. It does not follow house redirects, `authoritative_location`, or `brand_refs[]`; callers resolving those documents retain responsibility for their transport and trust rules. Its output preserves extension fields while excluding historical ephemeral `brand_context`, and it does not modify the input document.

An entry is identity data, not authorization evidence. Apply the registry's provenance and relationship-trust rules independently, and validate field shapes with the protocol's canonical schemas when needed.
