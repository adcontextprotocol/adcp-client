---
'@adcp/sdk': major
---

Ship a tree-shakeable dual ESM + CJS build.

The library now builds with tsup (`bundle: false`, one output file per source
module), emitting ESM (`.mjs`, reached via the `import` condition) alongside the
existing CommonJS (`.js`, reached via `require`), and declares `sideEffects` so
bundlers can drop unused code. Importing a single symbol no longer pulls the
whole barrel: `import { EventTypeValues } from '@adcp/sdk/types'` bundles to
under 1 KB with zod absent, down from ~1.9 MB.

`require('@adcp/sdk')` and the CLI keep working. This is a major version because
every consumer's module resolution goes through the reworked `exports` map
(each subpath now resolves `import` → `.mjs`, `require` → `.js`, `types` →
`.d.ts`).

The `@a2a-js/sdk` peer floor is raised from `^0.3.4` to `^0.3.13`: `@adcp/sdk/server`
imports `agentCardHandler` from `@a2a-js/sdk/server/express`, which only exists
from 0.3.13. CJS named-import interop masked a too-low pin; ESM surfaces it as a
load-time error, so the floor now matches what the code actually needs.

Dual-package safety: the request-signing and response-capture
`AsyncLocalStorage` stores are anchored on the global symbol registry so a
process that loads both builds shares one instance (no silently unsigned
requests), and the verified-signature brand uses `Symbol.for`. Consumers that
`instanceof`-check SDK errors across a mixed ESM/CJS boundary should use the
exported `isADCPError` / `isErrorOfType` guards instead.
