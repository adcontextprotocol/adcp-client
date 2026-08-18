# Compliance testing — `comply_test_controller`

Adopters who claim `compliance_testing` capability get a wire tool the AdCP storyboard runner uses to drive deterministic test scenarios (seed products, force creative statuses, simulate delivery, etc.).

```ts
import { createComplyController } from '@adcp/sdk/testing';

createAdcpServerFromPlatform(platform, {
  name: '...', version: '...',
  complyTest: {
    seed: { product: async (input) => seedProductFixture(input) },
    force: { creative_status: async (input) => forceStatus(input) },
    simulate: { delivery: async (input) => simulateDelivery(input) },
  },
});
```

`createAdcpServerFromPlatform` resolves the account through the platform's
trusted account resolver and rejects the controller request unless that account
is sandbox or mock. Buyer-supplied tool fields are not authorization state.

Framework auto-projects `capabilities.compliance_testing.scenarios` to `get_adcp_capabilities` based on which adapters you wired.

Production agents may additionally gate registration on deployment state so the
tool is absent from `tools/list` outside their compliance environment.

See `REFERENCE.md` for the full compliance-testing section.
