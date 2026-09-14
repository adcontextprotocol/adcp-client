# Supply-path verification

Use `verifySupplyPath` to check an owner-sold collection on a host publisher. It returns a state and five independently diagnosed legs: owner collection declaration, owner distribution/carriage, owner agent declaration, host authorization, and `INVENTORYPARTNERDOMAIN` evidence.

```typescript
import { verifySupplyPath } from '@adcp/sdk';

const result = await verifySupplyPath({
  owner_domain: 'channel-owner.example',
  host_domain: 'hoststream.example',
  agent_url: 'https://sales.channel-owner.example',
  collection_id: 'retro_news',
}, { source: 'authoritative', timeoutMs: 15_000, retainEvidenceBodies: true });

if (result.state !== 'verified_owner_sold') {
  // Apply your buying policy. Never treat owner_attested as authorization.
  console.log(result.legs);
}
// Store this evidence with the decision, including exact bytes when enabled.
console.log(result.sources.evidence);
```

| State | Meaning |
| --- | --- |
| `verified_owner_sold` | The owner's collection and carriage references resolve, and a host grant covers the complete carried property scope for this agent and collection without unevaluated constraints. |
| `host_delegated` | The host's ads.txt/app-ads.txt names the owner, and the owner declares the agent and collection. This weaker evidence does not bind the host to this agent or collection. Accept only under an explicit buyer policy. |
| `owner_attested` | The owner asserts carriage. This is discovery information, never host sales authorization. |
| `unverified` | The evidence cannot establish a path. |

The state is a supply-path decision, not a purchase guarantee, exclusivity claim, proof of delivery, or blanket product authorization. Country, effective-time and placement restrictions require an applicable context; this API fails closed on owner or host entries carrying those restrictions, including unknown authorization fields. Independent unrestricted entries can still establish a path. Collection distribution identifiers identify channels in a catalog; they are not host property IDs and are never silently converted into property IDs.

`collection_id` is optional for a domain-level inquiry. The evaluator considers complete individual collection paths and returns the strongest one as `resolved_collection_id`; it never combines carriage from one collection with authorization for another. For a particular product, always check its explicit collection IDs.

## Registry mode

```typescript
import { RegistryClient, verifySupplyPath } from '@adcp/sdk';

const request = {
  owner_domain: 'channel-owner.example',
  host_domain: 'hoststream.example',
  agent_url: 'https://sales.channel-owner.example',
  collection_id: 'retro_news',
};
const registry = new RegistryClient();
const cached = await registry.verifySupplyPath(request);
// Equivalent:
await verifySupplyPath(request, { source: 'registry', registry });
```

This is a typed wrapper over `POST /api/registry/verify/supply-path`. It preserves the registry's verdict, diagnostics, URLs, `cached` flag, timestamp and additional response fields. HTTP failures and malformed/inconsistent response shapes reject the promise. The wrapper requires `semantics_version: "1"`; an older registry must upgrade before it can serve this API. Registry responses describe cached evidence; `checked_at` is the decision time, not proof that the origin files were fetched then. The wrapper does not promote registry provenance into authoritative evidence.

## Discovery annotations

```typescript
import { annotateProductsSupplyPaths } from '@adcp/sdk';

// products must be the actual products returned by your seller.
const annotated = await annotateProductsSupplyPaths(products, sellerAgentUrl, {
  source: 'authoritative',
  maxPaths: 64,
});
for (const product of annotated) {
  console.log(product.supply_path_state, product.supply_path_verification);
}
```

Alternatively, configure a client with `validation.supplyPathVerification: { source: 'authoritative' }`. Completed `get_products` and `list_products` responses are annotated before completion handlers receive them, including resumed completion paths. Annotation is opt-in because it performs additional network requests.

Products combining `publisher_properties` with a collection selector in a different publisher namespace receive `supply_path_state`, the weakest state across their distinct external paths. Details live in `supply_path_verification.paths`. Authoritative mode uses `scope: 'product_properties'` and resolves every product selector against the host manifest; a verified path must cover all selected properties. Registry mode uses `scope: 'owner_host_collection'` because the endpoint accepts no product property context. Its annotation cannot certify the product's selected properties. Neither mode certifies placements, countries, effective dates, or other product restrictions. The weaker `host_delegated` state never establishes concrete product property coverage.
Products, ordering and unrelated seller fields are preserved. Computed annotation replaces any seller-authored verification fields. Local-only products have no external-path annotation. Invalid or omitted product `collection_ids` and path-limit overflow produce `unverified` with errors. Network policy refusal, cancellation and registry failures reject the operation instead of returning a seller-authored or stale success. Batches deduplicate both paths and evidence fetches within the operation, run at most four paths concurrently, and default to 64 distinct paths (maximum 256).

## Selector types

`AuthorizationCollectionSelector.collection_ids` is optional: omission grants all collections declared by that exact publisher. Present `[]`, `null`, non-array values and mixed-type ID arrays are invalid, not bulk grants. `ProductCollectionSelector` requires a non-empty explicit ID tuple. `CollectionDistribution` accepts `property_ids`, `identifiers`, or both. Public discovery and registry authorization types preserve these distinctions.

## Network and evidence policy

Authoritative mode starts at each publisher's HTTPS `/.well-known/adagents.json`. It uses the SDK's existing SSRF-safe fetcher: every DNS address is checked, the connection is pinned to a validated address, TLS verification remains enabled, and private/link-local/metadata addresses are refused. It does not contact the agent endpoint. No authorization credentials are sent to publisher evidence URLs.

HTTP redirects are limited to three within the exact HTTPS origin. A publisher-origin `authoritative_location` pointer or `superseded_by` migration may explicitly delegate to another HTTPS origin once; that target cannot redirect again. Credentials, nonstandard ports, mixed pointer/catalog files and chained pointers fail closed. This stricter authoritative API does not use community catalogs, cached fallback documents or MANAGERDOMAIN discovery. Those discovery routes need additional publisher scope proofs before they can serve as enforcement evidence.

The default deadline is 15 seconds for the whole path (or whole annotation batch), configurable up to 60 seconds. Each decompressed response is capped at 256 KiB, configurable up to 20 MiB, with a 64 MiB aggregate evidence budget per operation. The evaluator rejects arrays above 1,024 entries, strings above 8,192 characters, total input above 32,768 values, or a conservative selector-work estimate above four million operations with `evaluation_limit_exceeded`. Cancellation is supported through `signal`. `trustedFetchFn` is an explicit advanced egress hook: it assumes responsibility for DNS resolution, address policy and DNS rebinding protection; its evidence reports `connection_pinned: false`. It must honor request cancellation and manual redirect handling.

Evidence contains requested/resolved URLs, HTTP status, fetch time, SHA-256 of exact decompressed bytes, byte count, connection-pinning status and structured failure codes. `retainEvidenceBodies` also retains those bytes as JSON-safe `body_base64`, including pointer and HTTP redirect documents. Retain the entire chain alongside an enforcement decision. Bodies are untrusted publisher content; store them as opaque evidence, not instructions or trusted log fields. A live fetch is an observation at `fetched_at`, not a permanent authorization grant; reverify before subsequent decisions when freshness matters.

`inventory_partner_domain.failure: 'not_evaluated'` means the IAB fetch was skipped because host authorization already established the strongest state. A 404 is fetched-and-absent (`not_declared`); transport failures remain `ads_txt_unavailable`, with the cause in evidence. Websites use ads.txt, apps use app-ads.txt, and mixed surfaces require the owner in every applicable file. `unsupported_constraints` identifies unevaluated grant fields in `detail`.

Previously observed publisher revocations are held for seven days per publisher authority, including after the next manifest omits them. The default `InMemorySupplyPathRevocationStore` holds them for the process lifetime. For enforcement across restarts or multiple workers, configure a durable shared `SupplyPathRevocationStore`; its `observe` operation must be atomic and retain first-observation expiry for each `(publisher_domain, revoked_at)` tuple. Store failures and malformed revocation evidence reject verification. `sources.held_revocations` records the hold used in the decision. Keep observations from different publisher authorities isolated.

## Contract and conformance

The state/leg contract originates in [adcp#6897](https://github.com/adcontextprotocol/adcp/pull/6897) and its fail-closed companion. Both implementations execute the same [canonical supply-path vectors](https://github.com/adcontextprotocol/adcp/tree/main/static/compliance/source/test-vectors/supply-path), including each verdict, resolved collection, leg failure, parser result, and applicable IAB-file policy. The SDK vendors the JSON byte-for-byte from a reviewed upstream commit; provenance and checksums are recorded in `test/fixtures/supply-path/source.json`. Updating it requires selecting a reviewed upstream commit and rerunning both implementations. The runtime `semantics_version` prevents silent acceptance of registries running the older fail-open evaluator.
