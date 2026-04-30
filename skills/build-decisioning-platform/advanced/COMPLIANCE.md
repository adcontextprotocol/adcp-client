# Compliance testing — `comply_test_controller`

Adopters who claim `compliance_testing` capability get a wire tool the AdCP storyboard runner uses to drive deterministic test scenarios (seed products, force creative statuses, simulate delivery, etc.).

```ts
import { createComplyController } from '@adcp/sdk/testing';

createAdcpServerFromPlatform(platform, {
  name: '...', version: '...',
  complyTest: {
    sandboxGate: (input) => input.account?.sandbox === true,            // ONLY in sandbox accounts
    seed: { product: async (input) => seedProductFixture(input) },
    force: { creative_status: async (input) => forceStatus(input) },
    simulate: { delivery: async (input) => simulateDelivery(input) },
  },
});
```

Framework auto-projects `capabilities.compliance_testing.scenarios` to `get_adcp_capabilities` based on which adapters you wired.

Production agents typically gate registration on `process.env.ADCP_SANDBOX === '1'` so the tool isn't reachable in prod tools/list.

See `REFERENCE.md` for the full compliance-testing section.
