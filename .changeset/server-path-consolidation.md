---
'@adcp/sdk': minor
---

Consolidate v6 platform surface into `@adcp/sdk/server`. The `./server/decisioning` subpath is removed; everything previously under it (`createAdcpServerFromPlatform`, `DecisioningPlatform`, `SalesPlatform`, `CreativeBuilderPlatform`, `AccountStore`, `TenantRegistry`, `publishStatusChange`, `AdcpError`, etc.) now exports from `@adcp/sdk/server` alongside `createAdcpServer` and the rest of the v5 handler-bag API.

**Motivation.** The v6 path is internally a wrapper around `createAdcpServer` — it builds an `AdcpServerConfig` and calls v5 underneath. Hiding that under a separate subpath was misleading: LLM-driven adopters (and humans skimming docs) consistently landed on `@adcp/sdk/server` and missed the platform surface entirely. Putting both functions in one path makes the choice "which function shape do I want?" rather than "which import path is the real one?" and matches the actual dependency relationship.

**Migration.** Anywhere you imported from `@adcp/sdk/server/decisioning`, change to `@adcp/sdk/server`. The exports are identical; only the path changes.

```ts
// Before:
import { createAdcpServerFromPlatform, type DecisioningPlatform } from '@adcp/sdk/server/decisioning';

// After:
import { createAdcpServerFromPlatform, type DecisioningPlatform } from '@adcp/sdk/server';
```

No compat alias is shipped — `@adcp/sdk/server/decisioning` was preview-only and never published as GA. Only adopters who linked the in-flight 5.x branches need to update.
