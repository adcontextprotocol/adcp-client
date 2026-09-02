---
'@adcp/sdk': patch
---

Wire the `sales-dooh` specialism (AdCP 3.1.19, adcp#6619) into the decisioning platform contract. `RequiredPlatformsFor<'sales-dooh'>` now resolves to the core sales requirement, and `validatePlatform` enforces `platform.sales` or a compact `mediaBuyLifecycle` for `sales-dooh` claimers, matching `sales-guaranteed` / `sales-non-guaranteed` / `sales-broadcast-tv`. Previously the enum value was accepted but carried no compile-time or runtime platform-shape enforcement.
