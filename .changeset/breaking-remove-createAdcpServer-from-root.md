---
'@adcp/sdk': major
---

**BREAKING**: `createAdcpServer` is no longer exported from `@adcp/sdk/server` or `@adcp/sdk` (top-level). It now lives only at `@adcp/sdk/server/legacy/v5`. Update imports:

```diff
-import { createAdcpServer } from '@adcp/sdk/server';
+import { createAdcpServer } from '@adcp/sdk/server/legacy/v5';
```

Or — better — migrate to `createAdcpServerFromPlatform` and the typed `DecisioningPlatform` shape.

## Why this breaks

Empirical Emma matrix evidence: even with the `@deprecated` JSDoc tag and v6 examples in every skill, LLMs scaffolding agents from skill content **still pick `createAdcpServer`** as the canonical entry point. The deprecation tag is invisible to the prompt corpus; the symbol's presence at the top-level export is what teaches the LLM it's canonical. Removing the top-level export forces v6 selection: a fresh `npm install` adopter who reaches for `createAdcpServer` from the obvious path gets a hard import error, and the only path that resolves is the one explicitly named "legacy."

The `legacy/v5` subpath re-exports the full `@adcp/sdk/server` surface plus `createAdcpServer`, so v5 adopters migrate by changing one import path — destructured imports keep working without splitting:

```diff
-const { createAdcpServer, serve, verifyApiKey } = require('@adcp/sdk/server');
+const { createAdcpServer, serve, verifyApiKey } = require('@adcp/sdk/server/legacy/v5');
```

`docs/migration-5.x-to-6.x.md` already documented this in the cheatsheet (#3 of the five breaking changes); this PR makes the change actually breaking.
