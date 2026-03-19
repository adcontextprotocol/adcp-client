---
"@adcp/client": patch
---

Fix `audienceManagement` capability flag never being detected. The Zod schema and wire format define the feature flag as `audience_targeting`, but `parseCapabilitiesResponse` was reading `audience_management`. Renamed the internal `MediaBuyFeatures` property to match schema naming and updated `TASK_FEATURE_MAP` so `sync_audiences` correctly requires the flag.
