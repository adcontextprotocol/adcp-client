---
'@adcp/sdk': patch
---

v6.0.1: production gate the default `stateStore` + zod floor bump + missing-peer-dep doc.

**Production gate.** The 6.0 default `InMemoryStateStore` was a process-shared module singleton — correct for dev and single-tenant agents (closes the Pattern 3 SI session-loss bug at the documented `serve(() => createAdcpServer({...}))` factory pattern), but a multi-tenant production deployment that mints one `createAdcpServer` per resolved tenant would silently share state across tenants. 6.0 shipped this as a one-time `logger.warn`; 6.0.1 promotes it to a hard refusal mirroring `buildDefaultTaskRegistry`'s task-registry policy. Outside `{NODE_ENV=test, NODE_ENV=development}` the default in-memory store throws with a three-line explicit recovery path: pass `PostgresStateStore` (recommended), pass `new InMemoryStateStore()` explicitly (acknowledged), or set `ADCP_DECISIONING_ALLOW_INMEMORY_STATE=1` (ops escape hatch). Single-tenant adopters and dev/test deployments are unaffected.

**Gate ordering.** The new state-store gate fires AFTER the existing `idempotency: 'disabled'` gate so adopters who hit both surface the higher-severity error first (idempotency-disabled silently double-executes mutations on retry; state-store sharing leaks tenant data — both bad, idempotency goes first because the recovery is "wire a store" while state-store recovery is "pass your own").

**zod floor bump.** Peer-dep range tightened from `^4.1.0` to `^4.1.5` to match `json-schema-to-zod` (peers `^4.1.3`) and `ts-to-zod` (peers `^4.1.5`) — the SDK's own codegen-tool floors. Removes a build-vs-runtime range mismatch where adopters on `zod@4.1.0`–`4.1.4` would technically fall below the codegen tools' floors.

**Missing-peer-dep troubleshooting doc.** Added a sub-bullet to the migration doc explaining the `Cannot find module 'zod'` symptom (package manager didn't auto-install the peer) and the explicit-install fix. The SDK can't catch this at runtime — `import { z } from 'zod'` resolves at module load, before any SDK code runs — so a documentation pointer is the right shape.

**Test command env.** `npm test` and `npm run test:lib` now set `NODE_ENV=test` so the production gate doesn't refuse on test runs that don't already set the env. Existing tests that flip NODE_ENV mid-run to exercise production paths now also set `ADCP_DECISIONING_ALLOW_INMEMORY_STATE=1` alongside the existing task-registry ack.

897/897 server-side tests pass. The new state-store gate has 6 dedicated tests in `test/server-state-store-extensions.test.js` covering: production-throw, production+ack→allow, production+explicit-store→allow, development→allow, test→allow, undef-NODE_ENV→throw.
