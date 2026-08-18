# Migrating from 12.x to 14 beta

This is the direct upgrade path for applications skipping SDK 13. SDK 14 includes both SDK 13's canonical-creative and security boundary changes and the AdCP `3.2.0-beta.1` preview surface. Treat it as two review checkpoints even if you deploy one package update.

Install the beta explicitly:

```bash
npm install @adcp/sdk@beta
```

The npm `latest` tag remains on SDK 13, the maintained AdCP 3.1 stable line. If you do not need AdCP 3.2 yet, upgrading 12→13 first is the lower-risk production move.

## Direct upgrade checklist

Before deploying SDK 14 from SDK 12:

1. Convert primary application types and methods to canonical creative fields (`format_kind`, `format_options`, and `format_option_refs`). Rename intentional raw-wire code to explicit `Legacy*`, `legacy*`, or `*Legacy()` APIs.
2. Add an explicit `refAccess` policy to every `createTenantStore()` call.
3. Capture the exact Express `req.rawBody` before verifying a signed body-bearing request.
4. Remove placeholder/implicit webhook credentials, stop relying on webhook redirects, and choose unauthenticated receipt only for an intentionally isolated receiver.
5. Preserve and validate OAuth `state`; allow only HTTP(S) authorization redirects.
6. Narrow the structured error arm of `CreateMediaBuyPayload`, add all new `AssetInstance` variants to exhaustive switches, and read compliance scenario detail from `tracks` rather than `tested_tracks`.
7. Update server platform and legacy utility names that became explicit in SDK 13.
8. Make synchronous completion-webhook behavior explicit if you temporarily depend on duplicate inline and webhook delivery.
9. Add AdCP 3.2 tools only behind capability checks; retain established 3.0/3.1 lifecycle fallbacks.
10. Update request signing for the versioned 3.2 profile and return media-buy business state as `media_buy_status`.

The detailed SDK 13 changes remain documented in [Migrating from 12.x to 13.x](migration-12-to-13.md). The sections below collect the changes required to complete a direct 12→14 rollout rather than requiring a temporary SDK 13 deployment.

## Canonical creative boundary

Unqualified root exports such as `Product`, `Format`, `CreativeAsset`, `Package`, `CreateMediaBuyRequest`, and creative-bearing responses now mean canonical shapes. `{ agent_url, id }` creative identity is confined to legacy wire types and migration APIs.

```ts
import type {
  Product,                    // canonical
  SyncCreativesRequest,       // canonical
  LegacyProduct,              // raw wire compatibility
  LegacySyncCreativesRequest, // raw wire compatibility
} from '@adcp/sdk';
```

Primary client methods (`getProducts`, `createMediaBuy`, `updateMediaBuy`, `syncCreatives`, `listCreatives`, and delivery reads) accept and return canonical shapes. Use the conspicuous `getProductsLegacy()`, `createMediaBuyLegacy()`, `updateMediaBuyLegacy()`, `syncCreativesLegacy()`, `listCreativesLegacy()`, or `executeTaskLegacy()` only where raw compatibility is intentional.

Do not add `format_id` or `agent_url` to a canonical object to silence an upgrade error. Select a `format_option_id`, send `format_option_refs`, and give each creative a canonical `format_kind`. For custom legacy formats, configure a `legacyFormatConverter` and persist the projector's legacy route sidecar across process boundaries.

## Tenant, signing, webhook, and OAuth hardening

`createTenantStore()` now requires `refAccess`:

```ts
const accounts = createTenantStore({
  refAccess: 'auth-scoped',
  resolveByRef,
  resolveFromAuth,
  tenantId,
  accountForTenant,
});
```

Use `'auth-scoped'` when one credential belongs to one tenant. Use `'ref-routed'` only for a credential intentionally allowed to span tenants, then layer the necessary account, advertiser, or organization checks.

For Express request signatures, mount raw-body capture before verification:

```ts
const adapter = createExpressAdapter(/* ... */);
app.use(express.json({ verify: adapter.rawBodyVerify }));
app.post('/mcp', createExpressVerifier(/* ... */), handler);
```

Body-bearing requests fail closed without `rawBody`. HMAC webhook registrations need real credentials; automatically generated unauthenticated reporting webhooks are not sent. Webhook delivery and pinned fetches do not follow redirects. `allowUnauthenticatedWebhooks: true` is only an explicit compatibility escape for a receiver unreachable from untrusted networks.

OAuth flow handlers must preserve `state`, verify callback binding, and pass an HTTP(S) URL to `redirectToAuthorization()`. Literal-host SSRF validation now applies in every `NODE_ENV`; private/internal targets require the documented explicit opt-in and metadata addresses remain blocked.

## SDK 13 payload and API changes included in 14

- Narrow `CreateMediaBuyPayload` with `'errors' in payload` before reading success fields.
- Add `zip`, `published_post`, `card`, `pixel_tracker`, `vast_tracker`, and `daast_tracker` to exhaustive `AssetInstance` handling.
- Read canonical compliance scenarios from `ComplianceResult.tracks`; `tested_tracks` contains compact reference entries.
- `createAdcpServerFromPlatform()` does not emit a completion webhook for an inline terminal result by default. `autoEmitCompletionWebhooks: true` is a temporary non-conformant bridge.
- Rename raw platform hooks to explicit forms such as `buildCreativeLegacy`, `previewCreativeLegacy`, `listCreativeFormatsLegacy`, and the corresponding content-standard and brand-rights names.
- Put incrementally migrated raw handler groups under `legacyHandlers`.
- Replace removed registry hierarchy calls with `lookupBrand()`/`lookupBrands()` and inspect relationship evidence; use `{ fresh: true }` when a live origin check is required.
- Use `PayloadDigestOptions` for `computePayloadDigestSha256()` rather than the removed bare `RegExp` or `false` overloads.
- Use explicit legacy helper names such as `LEGACY_STANDARD_FORMATS`, `getStandardFormatsLegacy()`, `buildProductLegacy()`, and `buildListCreativesResponseLegacy()` for raw named-format work.

Compile and test these changes before enabling any 3.2 feature. That isolates SDK-boundary regressions from protocol-beta behavior.

## Add the AdCP 3.2 lifecycle

SDK 14 adds convenience methods and generated server/type/schema support for:

- `listProducts()`
- `requestProposals()`
- `refineProposals()`
- `declineProposals()`
- `buyProducts()`
- `acceptProposal()`
- `controlMediaBuy()`
- `reportPlanAdjustment()`
- `syncAgentNotificationConfigs()`

These do not replace the established tools for older agents. Discover `lifecycle_tools` and branch. Keep `getProducts()`/`createMediaBuy()`/`updateMediaBuy()` available for AdCP 3.0 and 3.1. Preserve the same idempotency key only for an exact retry; changed commercial intent requires a fresh key.

For sellers, implement the compact handlers on
`platform.mediaBuyLifecycle`; keep `platform.sales` as the 3.0/3.1 facade when
the endpoint serves mixed buyers. SDK 14's default MCP discovery then shows
the active 3.2 media-buy profile while leaving configured legacy names directly
callable. It also exposes `_meta.adcp_version` and `_meta.adcp_profile` in
`tools/list`. See the [surface comparison and compatibility test
matrix](guides/MEDIA-BUY-3.2-COMPATIBILITY.md).

For the established proposal path, treat only `get_products` refinements with
`scope: 'proposal'` and `action: 'finalize'` as mutations. SDK 14 clients attach
an idempotency key and exact retries must reuse it; SDK 14 servers replay a
keyed committed proposal rather than creating a second inventory hold. The
compatibility schema permits an older caller to omit the key, but that call has
no cache-backed replay protection. Catalog, brief, and non-finalizing
refinement calls remain read-only.

SDK 14 includes tool and trusted resolved session/account identity in replay
comparison. If a durable cache still contains an SDK 12 entry, the stronger
identity returns `IDEMPOTENCY_CONFLICT` rather than re-executing the mutation;
reconcile by natural key until the original replay TTL expires. SDK 14's buyer
retry policy escalates conflicts for this check and never automatically mints
a replacement key.

For `refine_proposals`, respect the advertised batch, alternative, and dimension limits; keep hard constraints distinct from the soft filters used by legacy `get_products`. Verify proposal expiry immediately before acceptance. See [AdCP 3.2 proposal negotiation](migration-adcp-3.1-to-3.2-proposals.md).

For conformance harnesses, AdCP 3.2's exact MCP schema requires `account` at
the top level of `comply_test_controller` requests. Replace
`context: { account, session_id }` with
`{ account, context: { session_id } }`; continue resolving that assertion
against trusted persisted sandbox/mock state before dispatch.

## Adopt version-aware request signing

SDK 14 retains the AdCP 3.0/3.1 unpadded Base64URL `Signature` profile and adds the AdCP 3.2 padded standard-Base64 signature profile with mandatory `Content-Digest`. `Content-Digest` itself remains an RFC 9530 structured field using padded standard Base64 across versions. High-level clients propagate their configured agent version. Low-level callers and server verifiers should bind a trusted negotiated/configured version to signing options; an unpinned verifier remains tolerant of both signature encodings for SDK 13 source compatibility.

For compatibility, an unpinned low-level verifier accepts either binary
serialization and enforces the caller-provided `covers_content_digest`
capability unchanged; it never infers a profile from request fields. Treat
that as a migration bridge, not a replacement for an endpoint or tenant pin.

Never select the profile from an unverified request field. Webhook signing remains on the existing legacy profile.

## Separate task state from media-buy state

Return `media_buy_status` from media-buy server handlers:

```ts
return {
  media_buy_id,
  media_buy_status: 'active',
};
```

Top-level `status` is reserved for task execution (`completed`, `working`, `submitted`, `input_required`, or `deferred`). SDK 14 retains compatibility overlays for older handler shapes, but new code should use the unambiguous field.

## Validation matrix

Run the SDK 13 boundary migration and 3.2 adoption as separate CI lanes, then test the combined package against every supported peer:

| Caller | Peer | What to prove |
|---|---|---|
| SDK 14 | AdCP 3.0 seller | established tools, legacy signing encoding, canonical projection |
| SDK 14 | AdCP 3.1 seller | established tools, legacy signing encoding, canonical projection |
| SDK 14 | AdCP 3.2 beta seller | compact lifecycle, mandatory digest, standard Base64 |
| AdCP 3.0/3.1 buyer | SDK 14 server | legacy tool facades and response overlays still work |

Canary by tenant or endpoint and retain SDK 13 as the stable rollback line. Do not make storage or orchestration depend exclusively on 3.2 until all required counterparties advertise and pass the beta workflow.
