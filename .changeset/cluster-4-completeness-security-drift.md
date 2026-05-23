---
'@adcp/sdk': patch
---

fix: cluster-4 sub-pieces 3/4 (#1955) — storyboard completeness, security, residual drift

Three small fixes that clear the remaining storyboard cluster failures from issue #1943:

**`storyboard-completeness.test.js`** — three new harness tasks declared in 3.1.0-beta.3 compliance storyboards were missing from the test's `HARNESS_TASKS` set:

- `expect_rate_limit_not_replayed` (universal/idempotency.yaml) — runner drives the `rate_limit_trip_runner` contract; no standalone request shape.
- `fetch_brand_jwks` (universal/webhook-emission.yaml) — raw HTTP probe against `brand_json_url` then walks `agents[].jwks_uri`. Not an AdCP tool call.
- `assert_jwks_purpose` (universal/webhook-emission.yaml) — JWKS inspection assertion checking for `adcp_use: 'webhook-signing'` keys. Runner-side check; no tool call.

Plus one tool missing from `TOOL_RESPONSE_SCHEMAS`: **`verify_brand_claim`** — now wired to `VerifyBrandClaimResponseSchema`. The schema has existed in `schemas.generated.ts` since 3.1.0-beta.3 was generated; only the response-schemas map was lagging.

**`storyboard-security.test.js`** — the `falls back to auth_required when selected storyboards all require discovered tools` test referenced storyboard ID `creative_sales_agent`, which was removed from the spec bundle in 3.1.0-beta.3. Repointed to `billing_gate_dispatch` (a tool-driven storyboard from the same era) — the test's intent (any tool-driven storyboard should fall through to `auth_required` when discovery 401s) is preserved.

**`storyboard-drift.test.js`** — two compliance-bundle YAML storyboards (`media_buy_seller/pending_creatives_to_start/{create_buy_no_creatives, assign_creative_to_package}`) still use `field_value_or_absent` on the envelope `status` field. AdCP 3.1.0-beta.2 made `status` schema-required, so those tolerances are technically dead code. The fix is upstream — the spec bundle needs to switch them to `field_value`. Skipped here with a clear `KNOWN_REDUNDANT_TOLERANCE_PENDING_SPEC_UPDATE` carve-out tracking the upstream owner. 3 of 712 tests skipped (2 mine + 1 pre-existing); 0 failures.

After this PR, cluster-4 (#1955) is fully cleared and the remaining #1943 backlog is cluster 1 (codegen-aliases-drift; needs codegen redesign) and cluster 6 (request-signing graders; needs `protocol_methods_required_for` feature impl per adcp#4326).
