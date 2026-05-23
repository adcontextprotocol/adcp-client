---
'@adcp/sdk': patch
---

fix: cluster-7 server-decisioning sweep — release-precision wire `adcp_version`, envelope status on error responses, plus test catch-up for 3.1.0-beta.3 field renames (#1955)

Two source-side fixes and four test catch-ups for the 3.1.0-beta.3 spec changes.

## Source-side

**`adcp_version` wire normalization** (`src/lib/version.ts` + wire emission in `src/lib/server/create-adcp-server.ts`). Per the spec note on `adcp_version`: "SDKs that read full-semver values from bundle metadata (e.g. `ComplianceIndex.published_version = "3.1.0-beta.1"`) MUST normalize to release-precision (`"3.1-beta.1"`) before emitting on the wire — meta-field values are NOT valid wire values." The wire regex (`^\d+\.\d+(-[a-zA-Z0-9.-]+)?$`) rejects strings with a patch digit, but the SDK was reading `ADCP_VERSION` ("3.1.0-beta.3") and stamping that verbatim on every response, failing schema validation on the receiver side.

New helper `toReleasePrecisionVersion()` strips the patch digit: `3.1.0-beta.3` → `3.1-beta.3`. Wired into `injectVersionIntoResponse` so every framework-emitted response carries a wire-valid version string. Legacy aliases (`v2.5`, `v3`) pass through unchanged (v2.5 uses `adcp_major_version` for transport instead).

**Envelope `status` on error responses** (`src/lib/server/create-adcp-server.ts`). `injectEnvelopeStatusIntoResponse` previously bailed when `response.isError === true`, leaving error responses without envelope `status`. AdCP 3.1.0-beta.2+ requires envelope `status` on EVERY response — success or error. The injector now maps `isError === true` → `status: 'failed'`, defaulting `'completed'` otherwise. Tools that need richer states (`submitted`, `working`, `input-required`) still set them explicitly; this injector only fills in the default.

## Test catch-up

- `test/server-assembly-helpers.test.js` — fixture gains `cache_scope: 'public'` on `get_products` validation call (required on populated-products branch since 3.1.0-beta.3).
- `test/server-decisioning-brand-rights.test.js` — 2 `buildAcquired` fixtures + 2 dispatch-result assertions rename `status` → `rights_status` (AcquireRights discriminator rename in 3.1.0-beta.3).
- `test/server-decisioning-to-wire-account.test.js` — 2 `governance_agents[]` fixtures drop `categories` (3.1.0-beta.3 tightened items to `additionalProperties: false` and dropped the deprecated field per the single-agent-owns-full-lifecycle clarification).
- `test/lib/update-rights-creative-approval.test.js` — `CreativeApprovalResponseSchema` 4-arm fixture: discriminator rename `status` → `approval_status` (adcp#4878), plus envelope `status: 'completed' | 'failed'` added on each arm.

110/110 across all 5 cluster-7 files pass; sibling regression check on 277 schema/storyboard/governance/extractor tests — 0 fail.

Closes #1955 cluster-7 contribution. Remaining clusters (1, 4 storyboard-completeness/security, 6) tracked separately.
