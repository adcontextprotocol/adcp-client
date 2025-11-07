---
"@adcp/client": major
---

Simplified API surface - removed deprecated exports and renamed primary client to `ADCPClient`.

## Breaking Changes

**Removed:**
- `AdCPClient` (deprecated wrapper with confusing lowercase 'd')
- `createAdCPClient()`, `createAdCPClientFromEnv()`
- `createADCPClient()`, `createADCPMultiAgentClient()`

**Moved to `/advanced`:**
- Old single-agent `ADCPClient` → `SingleAgentClient`
- `AgentClient`, protocol clients

**Renamed:**
- `ADCPMultiAgentClient` → `ADCPClient` (primary export)

## New API

```typescript
import { ADCPClient } from '@adcp/client';

const client = new ADCPClient([agentConfig]);
const client = ADCPClient.fromEnv();
```

Works for single or multiple agents. See `MIGRATION-v3.md` for migration guide.
