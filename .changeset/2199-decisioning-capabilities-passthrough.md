---
'@adcp/sdk': minor
---

feat(decisioning): expose `features`, `creative`, `account`, `overrides`, and `supported_versions` passthrough slots on `DecisioningCapabilities`

Closes #2199.

Adopters going through `definePlatform` / `createAdcpServerFromPlatform` (the documented v6 path) could not declare the per-feature capability granularity that the lower-level `createAdcpServer` exposes through `AdcpCapabilitiesConfig`. `CreateAdcpServerFromPlatformOptions extends Omit<AdcpServerConfig, 'capabilities' | ...>` cuts off the entire `AdcpCapabilitiesConfig` surface; `DecisioningCapabilities` covered a useful slice but had no path to `features`, `creative`, `account`, `overrides`, or `supported_versions`.

This adds five optional passthrough fields to `DecisioningCapabilities<TConfig>`:

- **`features?: Partial<MediaBuyFeatures>`** — adopter values form the base for `media_buy.features`. Auto-derived `audience_targeting` / `conversion_tracking` / `content_standards` booleans take precedence for those three keys (the framework's per-domain `media_buy` override is applied AFTER `capConfig.features` lays down the base inside `createAdcpServer`).
- **`creative?: Partial<CreativeCapabilities>`** — forwarded into `get_adcp_capabilities.creative`.
- **`account?: Partial<AccountCapabilities>`** — adopter base for the account block; existing `requireOperatorAuth` / `supportedBillings` projections overlay through the per-domain `account` override.
- **`overrides?: AdcpCapabilitiesOverrides`** — direct deep-merge passthrough. Adopter-declared overrides are merged BEFORE the framework's per-domain blocks (media_buy / brand / account / compliance_testing), so framework-derived blocks remain authoritative on keys the projection engine handles.
- **`supported_versions?: string[]`** — release-precision AdCP versions; forwarded into `get_adcp_capabilities.adcp.supported_versions`.

Non-breaking: all five fields optional. Adopters who declare none see identical wire output.

**Why this matters for adopters**

Conformance storyboards in 3.1.0-rc.10+ grade capability-absent scenarios as `fail` rather than `not_applicable` when the adopter can't declare not-supported feature blocks. A single-publisher / single-slot seller (no measurement vendor partnership, no wholesale catalog, no provenance verification pipeline) previously had 23 storyboards failing in our reference adopter because there was no path to declare those capabilities as unsupported through `definePlatform`. With this passthrough, adopters can honestly say "we don't support X" and the runner grades accordingly.

Migration: v5 adopters passing `supported_versions` via `opts.capabilities` on `AdcpServerConfig` should move it to `capabilities.supported_versions` on the platform declaration.
