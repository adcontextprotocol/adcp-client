---
"@adcp/client": minor
---

Update to latest AdCP schema with new features:

**Breaking type changes:**
- **BrandManifest tone**: Changed from `string` to object with `voice`, `attributes`, `dos`, `donts`
- **Format.type**: Now optional (`FormatCategory` deprecated in favor of assets array)

**Targeting & Signals:**
- **TargetingOverlay**: Added `age_restriction`, `device_platform`, and `language` fields
- **BrandManifest logos**: Added structured fields (`orientation`, `background`, `variant`)
- **Data Provider Signals**: New `DataProviderSignalSelector` and `SignalTargeting` types
- **get_signals**: Now supports `signal_ids` for exact lookups in addition to `signal_spec`

**Conversion Tracking:**
- New `EventType` and `ActionSource` enums
- `Package.optimization_goal` for target ROAS/CPA with attribution windows
- `Product.conversion_tracking` for conversion-optimized delivery
- New `sync_event_sources` and `log_event` tools (with Agent class methods)
- Delivery metrics: `conversion_value`, `roas`, `cost_per_acquisition`, event type breakdowns

**Creative:**
- `UniversalMacro` typed enum for creative tracking macro placeholders
- `BaseIndividualAsset` / `BaseGroupAsset` extracted as named interfaces

**Capabilities**: Added `age_restriction`, `device_platform`, `language`, and `conversion_tracking`
