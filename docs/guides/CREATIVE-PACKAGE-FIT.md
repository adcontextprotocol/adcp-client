# Check creative fit before assigning packages

`fitCreativeToPackages` evaluates a creative against each supplied package using the same decision engine as `sync_creatives` projection. It does not fetch assets, inspect bytes, contact a seller, or authorize an assignment. Supply measurements your integration has already established.

```typescript
import { fitCreativeToPackages } from '@adcp/sdk';

const decision = fitCreativeToPackages(creative, packages, {
  adcpVersion: '3.3.0-beta.3',
  primaryAssetFacts: { width: 600, height: 500, pixel_ratio: 2 },
});

for (const entry of decision.perPackage) {
  console.log(entry.package_id, entry.verdict, entry.reasons);
}

if (decision.wire && decision.perPackage.every(entry => entry.verdict === 'fits')) {
  // Retain this creative, including measured facts and any selected option pin.
  const preparedCreative = decision.wire.creative;
}
```

The variables `creative` and `packages` above are application inputs. Asset shapes must still satisfy the client request schema; measurements do not waive structural validation. Package contexts use the existing `creativeFormatProjection.selectorContainers` shape: `package_id`, `format_options`, and optionally scoped `format_option_refs`. Repeated contexts for a package and nested selector containers are applicable layers; alternatives within a layer are an OR. Unscoped contexts apply to every supplied package and never receive invented package IDs. Planning requires at least one identified package; empty or solely unscoped input returns a refusal without a wire representation.

The four verdicts distinguish proven acceptance (`fits`), missing evidence (`insufficient_facts`), known violation (`does_not_fit`), and the reserved `fits_with_adaptation`. This implementation does not emit `fits_with_adaptation`: it neither invents crop/resize/transcode permissions nor implements the proposed serve-adaptation contract. Applicable image layers must share one logical-size/density interpretation. VAST layers needing a shared placement size remain unproven without enough placement evidence. A known violation wins over missing facts within an option. Across alternatives, a fit wins; otherwise an unresolved option prevents a definitive rejection.

A declaration must assert `technical_requirements_complete: true` before it can establish a full fit. Missing primary assets, unproven asset-slot bindings, unresolved custom schemas, and unsupported technical constraints remain `insufficient_facts`. A wrong-sized image is a known violation even when unrelated evidence is missing. Image dimensions are intrinsic pixels; declared sizes are logical pixels. Accepted pixel ratios convert between them and do not grant arbitrary scaling permission. The published canonical image-density vectors are included in the tests.

`wire` describes a shared representation, not seller approval. It can exist alongside `insufficient_facts`; the seller must still validate the creative. A known package violation blocks `wire`. Conversely, packages can each fit physically while legacy reference constraints prevent a single shared `format_id`. A canonical product with multiple options of one kind requires a manifest option reference: the engine supplies an unambiguous compatible scoped pin or reports a wire refusal. It never picks the first fitting option.

Version 3.0/3.1 defaults to legacy wire and 3.2+ to canonical wire. If negotiation establishes a different mode, pass the same resolved `wireMode` used by delivery; this includes canonical-capable 3.1 peers. `adcpVersion` alone cannot describe the peer's capability evidence. If an integration deliberately retains the deprecated `playerSizedRefs` override, it must pass the same explicit value to planning and sync; the default retains strict legacy reconciliation.

Measurements use protocol units and names: `duration_ms`, `video_codec`, `codec` for hosted audio, `container_format`, `file_size_bytes`, string audio channel layouts such as `stereo`, and display-tag `delivery_type`. Set `asset_group_id` when identifying the primary asset is otherwise ambiguous. Contradictory measurements fail instead of overwriting existing facts. The prepared `wire.creative` includes those measurements. Alternatively, supply the same evidence when syncing, keyed by creative ID:

```typescript
const creativeFormatProjection = {
  selectorContainers: packages,
  creativeFacts: {
    [creative.creative_id]: {
      primaryAssetFacts: { width: 600, height: 500, pixel_ratio: 2 },
    },
  },
};
```

Use that object as the client's existing `creativeFormatProjection` option. This avoids a plan based on measurements that delivery never receives. Library-only creatives remain library upserts when request assignments refer to other creatives. With omitted or empty request assignments, supplied packages form the assignment scope.

For resolved VAST, `vastInlineCreatives` supplies linear creative groups and their `media_files`. Each linear group needs one complete MediaFile satisfying all declared requirements; facts from different files cannot be combined. MIME comparisons trim whitespace and ignore case. Missing facts remain unknown. This is not XML parsing or wrapper resolution. Player/placement dimensions are separate from encoded rendition dimensions; legacy shared-reference dimension reconciliation keeps its existing strict behavior. If a downgrade path cannot preserve a non-default image density or another reference parameter, it refuses instead of silently discarding the parameter. Adaptive bitrate envelope evidence and other unsupported constraints cannot establish full acceptance.

The optional `legacyFormatConverter`, `canonicalFormatLegacyResolver`, and `legacyFormatDefinitions` use existing exact-owner migration contracts. Callback exceptions propagate to the caller; invalid callback answers remain projection refusals. No network lookup is added. Pass JSON-compatible immutable inputs. The function does not mutate them. It does not establish seller ownership, catalog authenticity, or renderer behavior.

The broader fit-vector corpus proposed in adcontextprotocol/adcp#8644 and cross-SDK parity remain separate work. This API does not claim those implementations exist.
