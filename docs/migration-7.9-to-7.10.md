# Migrating from `@adcp/sdk` 7.9 to 7.10

> **Status: GA in 7.10.** Pure additive — every change is opt-in or
> auto-wired in a way that preserves the 7.x contract. Adopters running
> on 7.9 today see no behavior change on `npm update @adcp/sdk` unless
> they read the new fields. No breaking-change recipes; this doc is a
> V2-mental-model walkthrough.
>
> **The headline:** 7.10 makes the AdCP 3.1 V2 mental model
> (`Product.format_options[]` + `capability_id` + `format_schema`)
> first-class on `@adcp/sdk` while keeping every v1 path supported.
> Buyers writing new code think in V2; v1 sellers keep working
> transparently via auto-projection at the read seam and dual emission
> at the write seam.

## TL;DR — what landed

| Area | Headline |
|---|---|
| `getProducts` read side | Response auto-augmented with `format_options[]`; `format_ids[]` preserved alongside. Projection diagnostics surface on `result.data.projection.diagnostics`. |
| `createMediaBuy` write side | New `packageRefsForCapabilities(product, [capId, ...])` returns `{capability_ids, format_ids?}` ready to spread into a `PackageRequest`. Dual emission honors the 3.1.0-beta.2 spec convention (v2 sellers route by `capability_ids`; v1-only sellers fall back to `format_ids`). |
| Publisher format catalog | `extractPublisherFormats` / `scopePublisherFormats` / `resolveCapabilityId` on top of `validateAdAgents()` for the `adagents.json#/formats` AAO 3.1 catalog. |
| `format_schema` references | `fetchFormatSchema({uri, digest})` HTTPS+SSRF+digest-verified fetcher; `resolveSchemaRefs(schema, parentUri)` sandboxes `$ref` (same-origin + AAO mirror + intra-doc; `__proto__`/`file://` rejected; depth ≤ 8, count ≤ 256). |
| Spec version | Opt-in support for AdCP 3.1.0-beta.2 (`adcpVersion: '3.1.0-beta.2'` or `'3.1-beta'`). Primary pin stays at the GA `ADCP_VERSION` (3.0.12). |
| `discovery` types | `AdAgentsJson.formats?` extension (additive). |

## The big idea: V2 mental model

AdCP 3.1 introduces a **V2 mental model** for ad-format declarations.
Instead of products carrying opaque `format_ids[]` (the v1 path), each
product publishes `format_options[]` — a list of canonical-format
declarations with a stable `capability_id` per entry. Buyers read this
shape, pick a capability, and write back by capability — never touching
v1 vocabulary.

The challenge: v1 sellers exist (every 3.0.x agent in the field), v2
sellers are starting to ship, and adopters want one buyer codebase that
works against both. 7.10's whole architecture is about making the V2
mental model wire-agnostic.

```
                    7.10 buyer codebase reads + writes V2

  ┌─────────────────┐                          ┌─────────────────┐
  │   getProducts   │                          │  createMediaBuy │
  └────────┬────────┘                          └────────┬────────┘
           │                                            │
           ▼                                            ▼
  ┌─────────────────┐                          ┌─────────────────┐
  │  withFormatOpts │  ← auto-wired           │  packageRefsFor │
  │   (auto v1→v2)  │     (read seam)         │  Capabilities   │
  └────────┬────────┘                          │  (write seam)   │
           │                                   └────────┬────────┘
           ▼                                            │
   format_options[]                                     │ dual emission:
   format_ids[]  (preserved)                            │  capability_ids[]
   projection.diagnostics[]                             │  format_ids[]
                                                        ▼
                                              ┌─────────────────┐
                                              │   wire payload   │
                                              │  v2 sellers route│
                                              │  v1 sellers      │
                                              │   fall back      │
                                              └──────────────────┘
```

## 1. Read side: `format_options[]` is automatic

`AgentClient.getProducts()` auto-projects v1 `format_ids[]` to V2
`format_options[]` and attaches the result to the response. No call-site
changes; new code reads `format_options`, old code reads `format_ids`,
both are present.

```ts
const result = await agent.getProducts({ brief: 'Premium coffee brands' });
const product = result.data.products[0];

// V2 mental model — always populated, regardless of whether the seller
// emitted v1 or v2 on the wire.
product.format_options[0].format_kind;     // 'image'
product.format_options[0].capability_id;   // 'iab_mrec' (when seller publishes one)
product.format_options[0].v1_format_ref;   // back-reference to v1 format_id

// V1 view — still there for any pre-7.10 code or v1-only paths.
product.format_ids[0].id;

// Projection diagnostics — non-empty when a v1 format didn't have a v2 mapping.
result.data.projection.diagnostics.forEach(d => console.warn(d));
```

Opt out (rare — storyboard / compliance harnesses asserting exact
seller emission):

```ts
const raw = await agent.getProducts({ brief: '...' }, undefined, { project: false });
// raw.data is the unmodified wire response.
```

For non-`AgentClient` callers (cached payloads, A2A passthrough,
fixtures), the same projection is exposed as a standalone helper:

```ts
import { withFormatOptions } from '@adcp/sdk/v2/projection';

const { response, diagnostics } = withFormatOptions(rawWireResponse);
```

## 2. Write side: pick by `capability_id`, get dual emission

`packageRefsForCapabilities(product, capabilityIds[])` resolves a list
of `capability_id`s against the product's `format_options[]` and returns
the `{capability_ids, format_ids?}` pair to spread into a `PackageRequest`.

```ts
import { packageRefsForCapabilities } from '@adcp/sdk/v2/projection';

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

The rendered wire payload looks like:

```json
{
  "package_id": "pkg-1",
  "product_id": "...",
  "pricing_option_id": "...",
  "capability_ids": ["nytimes_mrec", "nytimes_video_30s"],
  "format_ids": [
    {"agent_url": "https://creative.adcontextprotocol.org/", "id": "display_300x250_image"},
    {"agent_url": "https://creative.adcontextprotocol.org/", "id": "video_standard_30s"}
  ],
  "budget": {"currency": "USD", "total": 5000}
}
```

| Seller version | Reads `capability_ids` | Reads `format_ids` |
|---|---|---|
| 3.0.x (v1-only) | ignores via `additionalProperties: true` | yes (dual emission) |
| 3.1.0-beta.0 / beta.1 | ignores (field added in beta.2) | yes (dual emission) |
| 3.1.0-beta.2+ | yes (V2-native route) | ignored when `capability_ids` present |

`format_ids` is omitted entirely (not emitted as `[]`) when every chosen
capability is V2-only. Spec's "neither present → default to all" fallback
fires for v1 sellers in that case, which is the correct behavior.

### Failure modes

`packageRefsForCapabilities` throws `CapabilityIdsLookupError` with a
normalized `.code` so adopters can branch fallback logic at compose
time rather than waiting for the seller to reject:

```ts
import { packageRefsForCapabilities, CapabilityIdsLookupError } from '@adcp/sdk/v2/projection';

try {
  const refs = packageRefsForCapabilities(product, ['nytimes_mrec']);
  // ...
} catch (e) {
  if (e instanceof CapabilityIdsLookupError) {
    switch (e.code) {
      case 'capability_ids_not_published':
        // Product is v1-only or no entry publishes capability_id.
        // Fall back to legacyFormatIdsFromOptions for this product.
        break;
      case 'unknown_capability_id':
        // Buyer asked for a capability the seller doesn't offer.
        // Inspect e.available and e.missing.
        break;
      case 'empty_input':
        // Caller passed []. Omit capability_ids entirely instead.
        break;
      case 'invalid_product':
        // Likely caller passed `products` array instead of `products[0]`.
        break;
    }
  } else throw e;
}
```

### V1-only adopters: `legacy*` helpers

If you're writing strictly to v1 sellers, or to products whose
`format_options[]` entries don't publish `capability_id`, three helpers
are scoped to that path:

```ts
import {
  legacyFormatIdsFromOptions,       // pick by declaration; throw on no-v1-form
  tryLegacyFormatIdsFromOptions,    // non-throwing variant for iterate-and-pick
  legacyFormatIdsForCapability,     // resolve a stored capability_id to v1
} from '@adcp/sdk/v2/projection';
```

These are **semantic narrowing, not deprecation** — they solve a
different problem (single-target v1 payload) than
`packageRefsForCapabilities` (dual-emission V2 payload), and they're
supported indefinitely. The sunset story is tracked at
[adcp-client#1899](https://github.com/adcontextprotocol/adcp-client/issues/1899)
against the upstream AdCP 4.0 `capability_id` MUST tightening
(adcp#4857).

## 3. Publisher format catalog (`adagents.json#/formats`)

AdCP 3.1 publishers can publish their format catalog at their domain
via the `formats[]` extension on `adagents.json`. 7.10 layers
catalog-aware helpers on top of the existing `validateAdAgents()`
discovery flow — no new fetcher, same SSRF + cycle-detection +
MANAGERDOMAIN-fallback guarantees.

```ts
import { validateAdAgents } from '@adcp/sdk/discovery';
import {
  extractPublisherFormats,
  scopePublisherFormats,
  resolveCapabilityId,
} from '@adcp/sdk/v2/publisher-catalog';

const { adagents } = await validateAdAgents('nytimes.com');

// All formats the publisher accepts, across every property.
const all = extractPublisherFormats(adagents);

// Just the ones scoped to a specific property.
const homepage = scopePublisherFormats(all, { propertyId: 'homepage' });

// Resolve a placement's `capability_id` reference.
const placementFormat = resolveCapabilityId(homepage, 'nytimes_homepage_takeover_premium');
```

The publisher catalog is the cross-publisher equivalent of a single
seller's `format_options[]`. Same `capability_id` discipline; one extra
hop to fetch the publisher's adagents.json.

## 4. `format_schema` references

Custom format declarations carry a URI+digest reference to an
out-of-tree JSON Schema document. 7.10 ships the spec's normative fetch
contract + `$ref` sandboxer.

```ts
import { fetchFormatSchema, resolveSchemaRefs } from '@adcp/sdk/v2/format-schema';

// Step 1: fetch + verify digest. HTTPS-only, 1 MiB body cap, 5 s
// timeout, manual redirect handling, SHA-256 verification, immutable
// uri@digest cache. SSRF-guarded.
const { schema, ref } = await fetchFormatSchema(formatSchemaRef);

// Step 2: resolve every `$ref` inline, bounded. Same-origin + AAO
// mirror (creative.adcontextprotocol.org) + intra-doc pointers only;
// file:// rejected; __proto__ / constructor / prototype rejected;
// depth ≤ 8, count ≤ 256.
const { schema: resolved, refCount, maxDepthSeen } = await resolveSchemaRefs(schema, ref.uri);

// `resolved` is safe to feed to Ajv. Every $ref already inlined.
```

The sandboxer accepts a custom `fetchExternal` if you want per-`$ref`
digest enforcement (e.g., from an internal registry of `uri@digest`
pairs):

```ts
const { schema: resolved } = await resolveSchemaRefs(schema, ref.uri, {
  fetchExternal: async (uri) => {
    const digestFromRegistry = await myRegistry.lookup(uri);
    return (await fetchFormatSchema({ uri, digest: digestFromRegistry })).schema;
  },
});
```

`DEFAULT_MAX_KEYWORDS` (10 000) and `DEFAULT_VALIDATION_BUDGET_MS`
(250) are exported for the eventual Ajv-wiring layer — actual
enforcement of the schema-compile DoS bounds is the manifest
validator's job and lands in a future release.

## 5. AdCP 3.1.0-beta.2 opt-in

Pin to the beta to validate against its schemas (catalog-sync cluster,
`capability_ids` on PackageRequest, etc.):

```ts
const client = new AdCPClient({
  agentUrl: 'https://salesagent.example.com',
  adcpVersion: '3.1-beta',         // canonical release-precision pin
  // or '3.1.0-beta.2' for exact-version pinning in cross-version tests
});
```

The SDK's primary pin stays at the GA `ADCP_VERSION` — this is a
side-bundle, not a default move. Schemas live at
`schemas/cache/3.1.0-beta.2/`; refresh with `npm run sync-schemas:3.1-beta`
+ `npm run generate-types:3.1-beta`.

## 6. What v1-only adopters should do

**Nothing.** Every v1 path keeps working:

- `Product.format_ids[]` is still on every product response (auto-projection is purely additive — it adds `format_options[]` alongside, doesn't remove the v1 field).
- `PackageRequest.format_ids[]` is still the wire field v1 sellers route on. The dual-emission helper continues to populate it.
- The `legacy*` helpers exist precisely for adopters who want to keep authoring v1 packages from V2 products.

If you're not ready to think in V2 yet, ship 7.10 and keep writing v1
code. The reading side just got richer; the writing side got an
optional new path.

## 7. What to expect at 8.0

The 8.0 design doc
([`docs/development/v3.1-sdk-design.md`](./development/v3.1-sdk-design.md))
narrows the public Product type to V2-only — `format_ids[]` comes off
the public surface and lives only on legacy adapters. 8.0 also adds
**per-agent version negotiation** so the SDK can auto-detect a seller's
wire version and switch the projection direction without an explicit
opt-in.

8.0 is gated on the upstream AdCP v1 deprecation tightening (floor
2027-Q4, ceiling 2029-Q1). 7.10's posture is "ship the V2 ergonomics
without committing to the narrowing yet" — adopters get the mental
model at 7.10, the type surface narrows at 8.0.

## Forward references

- [adcontextprotocol/adcp#4844](https://github.com/adcontextprotocol/adcp/pull/4844) — `capability_ids` on `PackageRequest` (landed in 3.1.0-beta.2; this PR implements the SDK side).
- [adcontextprotocol/adcp#4866](https://github.com/adcontextprotocol/adcp/pull/4866) — `mirror.adcontextprotocol.org` deprecation (landed in 3.1.0-beta.2; SDK's `DEFAULT_MIRROR_HOSTS` collapsed to the surviving `creative.adcontextprotocol.org` anchor).
- [adcp-client#1899](https://github.com/adcontextprotocol/adcp-client/issues/1899) — sunset tracker for the `legacy*` helpers, tied to upstream adcp#4857.

_Last updated: 2026-05-21_
