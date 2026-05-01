---
'@adcp/sdk': minor
---

feat(cli+harness): `adcp mock-server sales-social` — third specialism (TikTok-flavored, OAuth + sync_audiences + CAPI)

Adds the third mock-server in the matrix v2 family. Stresses three SDK surfaces the existing mocks (signal-marketplace, creative-template) don't touch:

1. **OAuth 2.0 client_credentials with refresh-token rotation.** Adapters exchange `client_id` + `client_secret` for an `access_token` at `POST /oauth/token`, attach the bearer on every API call, and refresh via the same endpoint with `grant_type=refresh_token` when the token expires. Refresh tokens rotate on use (single-use). This is the first matrix-v2 test of the SDK's OAuth code path that shipped in 5.9.0.

2. **Hashed-PII audience uploads.** Custom audiences accept members as SHA-256-hashed lowercase identifiers (`hashed_email_sha256`, `hashed_phone_sha256`, etc.). Uploading raw PII or wrong-cased hex is rejected with `400 invalid_hash_format`. Mirrors how Meta Custom Audiences, TikTok DMP, LinkedIn Matched Audiences all work.

3. **CAPI / Conversion API event ingestion.** Server-to-server conversion events arrive at `POST /event/track` with a hashed identifier (`email_sha256`, `phone_sha256`, or `external_id_sha256`) and event metadata. Events without a matchable identifier are dropped (counted in `events_dropped`); a batch of all-unmatchable events returns `400 no_matchable_events`.

Plus the supporting upstream surface required by the `sales_social` storyboard:

- Advertiser profile (`GET /v1.3/advertiser/{id}/info`)
- Catalog CRUD + bulk upload (sync_catalogs mapping)
- Creative portfolio CRUD (sync_creatives mapping)
- Pixel CRUD (sync_event_sources mapping)

**Multi-tenancy via path** (`/v1.3/advertiser/{advertiser_id}/...`). Two seeded advertisers with overlapping access. Single OAuth client authorized for both — matches the standard walled-garden model where one app credential serves multiple seats.

**Refactor**: `MockServerHandle.apiKey: string` is replaced by a polymorphic `MockServerHandle.auth: MockServerAuth` discriminated union (`{ kind: 'static_bearer', apiKey } | { kind: 'oauth_client_credentials', clientId, clientSecret, tokenPath }`). The matrix harness branches on `auth.kind` when building the adapter prompt — different flows produce different adapter wiring.

Run with:

```bash
npx @adcp/sdk mock-server sales-social --port 4502
# or as part of the skill-matrix:
npm run compliance:skill-matrix -- --filter sales_social
```

**21 new smoke tests** in `test/lib/mock-server/sales-social.test.js` cover OAuth handshake (success, bad client_secret, refresh-token rotation, old-token-invalidation), bearer-required API gating, audience create + hashed-PII upload + raw-PII rejection + idempotency conflict, CAPI event ingest with matchable/unmatchable identifiers + unknown pixel, catalog + creative flows, and the unified principal-mapping handle shape.

Refs adcontextprotocol/adcp-client#1155.
