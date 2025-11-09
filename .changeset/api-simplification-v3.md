---
"@adcp/client": major
---

Simplified API surface - removed deprecated exports and renamed primary client to `AdCPClient`.

## Breaking Changes

**Removed:**
- `AdCPClient` (deprecated wrapper with confusing lowercase 'd')
- `createAdCPClient()`, `createAdCPClientFromEnv()` factory functions
- `createADCPClient()`, `createADCPMultiAgentClient()` factory functions
- `SingleAgentClient` and `AgentClient` exports from `/advanced` (use `client.agent(id)` instead)

**Moved to `/advanced`:**
- Protocol-level clients: `ProtocolClient`, `callMCPTool`, `callA2ATool`, `createMCPClient`, `createA2AClient`

**Renamed:**
- `ADCPMultiAgentClient` → `AdCPClient` (primary export, proper AdCP capitalization)

## New API

```typescript
import { AdCPClient } from '@adcp/client';

const client = new AdCPClient([agentConfig]);
const client = AdCPClient.fromEnv();
```

Works for single or multiple agents. See `MIGRATION-v3.md` for migration guide.
