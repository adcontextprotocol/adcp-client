---
"@adcp/client": minor
---

Update to latest AdCP schema with new features:

- **TargetingOverlay**: Added `age_restriction` (for compliance), `device_platform` (OS targeting), and `language` fields
- **BrandManifest logos**: Added structured fields (`orientation`, `background`, `variant`) for reliable filtering by creative agents
- **BrandManifest tone**: Changed from string to object with `voice`, `attributes`, `dos`, `donts` for richer brand voice guidelines
- **Data Provider Signals**: New `DataProviderSignalSelector` type for selecting signals from data provider catalogs
- **Signal Targeting**: New `SignalTargeting` types supporting binary, categorical, and numeric signal targeting
- **get_signals**: Now supports `signal_ids` for exact lookups in addition to `signal_spec` semantic discovery
- **Capabilities**: Added `age_restriction`, `device_platform`, and `language` capability reporting

Updated test files to use new structured logo and tone fields.
