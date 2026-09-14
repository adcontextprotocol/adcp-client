---
'@adcp/sdk': minor
---

Adopt the signed AdCP 3.2.0-rc.3 schema and compliance bundles as the default wire release.

Moving the pin activates the `content_mismatch` consumer status and its closed
`mismatch_code` across the published `ReportingConsumerStatusSchema` /
`SyncReportingStatusRequestSchema` exports and the seller ledger's consumer-status types.
The machinery that keeps those two in step with the bundle landed separately in #2911,
which derives both the ledger statement type and the Zod conditional arms from the pinned
schema; this pin is what supplies the rc.3 arms it reads. Verified: the regenerated
validator requires the obligation id, the revision id, the recomputed
`observed_revision_content_sha256`, and `mismatch_code` for `content_mismatch`, forbids
`failure_code` there, and forbids `mismatch_code` on the four pre-existing statuses.

rc.3 also publishes `core/media-buy-available-action-id.json`, so the generated
`update_media_buy` dispatch table gains the structured-only
`update_media_buy_frequency_cap` action and its `frequency_cap` field binding. Media-buy
preflight already resolved that binding from the generated table, so the shared
media-buy frequency cap becomes dispatchable with no adopter change.

3.2 prereleases remain exact pins: rc.3 replaces rc.2 in `COMPATIBLE_ADCP_VERSIONS` and
only the current prerelease's schema bundle ships. Pin `adcpVersion: '3.2-rc'` to follow
whichever 3.2 release candidate a given SDK build carries.
