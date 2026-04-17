---
'@adcp/client': minor
---

Pull storyboards from the AdCP compliance tarball instead of bundling them.

Released as a minor bump: 5.0 was intentionally shipped incomplete while the
upstream compliance tarball + cosign signing work landed (adcontextprotocol/adcp#2273).
5.0 has not seen meaningful adoption, so the removals below are treated as finishing
the 5.x surface rather than a 6.0 breaking release.

`npm run sync-schemas` fetches `/protocol/{version}.tgz` from adcontextprotocol.org,
verifies its sha256 sidecar, and extracts both `schemas/` and `compliance/` into
`schemas/cache/{version}/` and `compliance/cache/{version}/`. Per-file schema sync is kept
as a fallback. The compliance cache ships with the published npm package — no network
call required for first use.

When a pinned version ships cosign sidecars (`.sig` / `.crt`, per
adcontextprotocol/adcp#2273), `sync-schemas` verifies them against the upstream
release workflow's Sigstore identity. `latest.tgz` is intentionally unsigned and skipped.
Missing sidecars or a missing `cosign` binary fall back to checksum-only trust with a
clear log line; a present-but-failed verification is a hard error.

Storyboard selection is driven by the agent's `get_adcp_capabilities` response:
`supported_protocols` resolves to domain baselines and `specialisms` resolves to
specialism bundles. The runner fails closed when:
- an agent declares a specialism whose bundle isn't in the local cache (stale cache — re-sync);
- an agent declares a specialism whose parent domain isn't in `supported_protocols`.
Unknown `supported_protocols` entries (new spec version, typo) log a warning and are skipped.

`discoverAgentProfile` now calls `get_adcp_capabilities` to populate
`profile.supported_protocols` + `profile.specialisms`. A probe failure is surfaced
as `profile.capabilities_probe_error` and a top-level error-severity observation,
rather than silently downgrading the assessment.

**Breaking changes**:

- The `storyboards/` directory is no longer shipped in the npm package. Consumers
  relying on direct file paths must read from `/compliance/{version}/` on
  adcontextprotocol.org or the `compliance/cache/` tree after running sync.
- `ComplyOptions.platform_type` is removed. Callers that still pass it get a
  runtime error pointing to this changeset. Capability-driven selection replaces
  platform-type curated lists. Pass `storyboards: [id]` for explicit/targeted runs;
  bundle ids (e.g., `sales-guaranteed`) expand to every storyboard in the bundle.
- `ComplianceResult.platform_coherence` and `ComplianceResult.expected_tracks` are
  removed along with the `expected` track status.
- `ComplianceSummary.tracks_expected` is removed.
- Removed exports: `PlatformType`, `SalesPlatformType`, `CreativeAgentType`,
  `SponsoredIntelligenceType`, `AINativePlatformType`, `PlatformProfile`,
  `PlatformCoherenceResult`, `CoherenceFinding`, `InventoryModel`, `PricingModel`,
  `getPlatformProfile`, `getAllPlatformTypes`, `getPlatformTypesWithLabels`,
  `PLATFORM_STORYBOARDS`, `getStoryboardIdsForPlatform`, `extractScenariosFromStoryboard`,
  `filterToKnownScenarios`, `loadBundledStoryboards`, `loadBundledScenarios`,
  `getStoryboardById`, `getScenarioById`, `getStoryboardsForPlatformType`,
  `getComplianceStoryboards`, `getApplicableComplianceStoryboards`, `listStoryboards`.
- CLI: `adcp storyboard list --platform-type` and
  `adcp storyboard run --platform-type` / `--list-platform-types` are removed.
  Added `adcp storyboard run <agent> --file <path.yaml>` for ad-hoc spec-evolution runs.

New exports on `@adcp/client/testing`: `resolveStoryboardsForCapabilities`,
`resolveBundleOrStoryboard`, `findBundleById`, `listBundles`, `loadBundleStoryboards`,
`listAllComplianceStoryboards`, `getComplianceStoryboardById`, `loadComplianceIndex`,
`getComplianceCacheDir`.
