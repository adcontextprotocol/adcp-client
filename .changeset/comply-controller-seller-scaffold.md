---
'@adcp/client': minor
---

Add `createComplyController` to `@adcp/client/testing` — a domain-grouped
seller-side scaffold for the `comply_test_controller` tool. Takes typed
`seed` / `force` / `simulate` adapters and returns `{ toolDefinition,
handle, handleRaw, register }` so a seller can wire the tool with a single
`controller.register(server)` call.

```ts
import { createComplyController } from '@adcp/client/testing';

const controller = createComplyController({
  // Gate on something the SERVER controls — env var, resolved tenant flag,
  // TLS SNI match. Never trust caller-supplied fields like input.ext.
  sandboxGate: () => process.env.ADCP_SANDBOX === '1',
  seed: {
    product: ({ product_id, fixture }) => productRepo.upsert(product_id, fixture),
    creative: ({ creative_id, fixture }) => creativeRepo.upsert(creative_id, fixture),
  },
  force: {
    creative_status: ({ creative_id, status }) => creativeRepo.transition(creative_id, status),
  },
});
controller.register(server);
```

The helper owns scenario dispatch, param validation, typed error
envelopes (`UNKNOWN_SCENARIO`, `INVALID_PARAMS`, `FORBIDDEN`), MCP
response shaping, and seed re-seed idempotency (same id + equivalent
fixture returns `previous_state: "existing"`; divergent fixture returns
`INVALID_PARAMS` without touching the adapter). Transition enforcement
stays adapter-side so the controller and the production path share a
single state machine.

Hardened against common misuse: sandbox gate requires strict `=== true`
(a gate that returns a truthy non-boolean denies, not allows); fixture
keys `__proto__` / `constructor` / `prototype` are rejected with
`INVALID_PARAMS`; the default seed-fixture cache is capped at 1000
net-new keys to bound memory under adversarial seeding; and the
`toolDefinition.inputSchema` is shallow-copied so multiple controllers
on one process don't share a mutable shape.

`list_scenarios` bypasses the sandbox gate so capability probes always
succeed — buyer tooling can distinguish "controller exists but locked"
from "controller missing", while state-mutating scenarios remain gated.
`register()` emits a `console.warn` when no `sandboxGate` is configured
and no `ADCP_SANDBOX=1` / `ADCP_COMPLY_CONTROLLER_UNGATED=1` env flag is
set, so silent fail-open misuse becomes loud without breaking the
optional-gate API shape.

Also extends `TestControllerStore` with the five seed methods
(`seedProduct`, `seedPricingOption`, `seedCreative`, `seedPlan`,
`seedMediaBuy`) and exports `SEED_SCENARIOS`, `SeedScenario`,
`SeedFixtureCache`, and `createSeedFixtureCache`. Existing
`registerTestController` callers now pick up the seed surface and an
internal idempotency cache for free. Closes #701.
