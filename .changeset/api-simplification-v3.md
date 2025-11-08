---
"@adcp/client": major
---

Simplified API surface - removed deprecated exports and renamed primary client to `AdCPClient`.

## Breaking Changes

**Removed:**
- `AdCPClient` (deprecated wrapper with confusing lowercase 'd')
- `createAdCPClient()`, `createAdCPClientFromEnv()`
- `createAdCPClient()`, `createADCPMultiAgentClient()`

**Moved to `/advanced`:**
- Old single-agent `AdCPClient` → `SingleAgentClient`
- `AgentClient`, protocol clients

**Renamed:**
- `ADCPMultiAgentClient` → `AdCPClient` (primary export)

## New API

```typescript
import { AdCPClient } from '@adcp/client';

const client = new AdCPClient([agentConfig]);
const client = AdCPClient.fromEnv();
```

Works for single or multiple agents. See `MIGRATION-v3.md` for migration guide.
