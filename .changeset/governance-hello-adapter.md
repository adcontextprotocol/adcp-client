---
"@adcp/sdk": minor
---

Added `examples/hello_seller_adapter_governance.ts`, a worked governance adapter starter covering `governance-spend-authority` and `property-lists` specialisms.

The adapter demonstrates `defineCampaignGovernancePlatform` and `definePropertyListsPlatform` wired through `createAdcpServerFromPlatform`, with `createComplyController` `seed.plan` integration for storyboard-driven testing. Runs without an upstream HTTP backend — governance state is agent-owned via in-memory Maps with SWAP comments for production `ctx.store` migration.

Also adds a `### Hello Adapter examples` section to `examples/README.md` documenting both the signals and governance adapters. Addresses the adopter gap noted in #1332.
