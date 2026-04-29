---
name: build-decisioning-signal-marketplace
description: Build an AdCP v6.0 (preview) signal-marketplace OR signal-owned decisioning platform — a data provider serving audience signals to buyers. Use ONLY when the user explicitly wants the v6.0 DecisioningPlatform shape; for v5.x handler-style signals agents, use `build-signals-agent` instead.
---

# Build a Signals Decisioning Platform (v6.0 preview)

You're building a **signals data provider** that fits one of two AdCP specialisms:

- `signal-marketplace` — third-party data brokers serving curated signals (LiveRamp, Oracle Data Cloud, third-party DMPs)
- `signal-owned` — first-party data providers serving their own signals (publisher first-party data, retailer customer-graph)

Both share the same `SignalsPlatform` interface. Pick the specialism that matches your relationship to the data; the implementation shape is identical.

## When this skill applies

- User wants a signals platform on the **v6.0 DecisioningPlatform** surface (preview, pre-GA)
- Specialism: `signal-marketplace` OR `signal-owned`
- SDK package: `@adcp/sdk` v5.18+ with the `decisioning` preview surface

**Wrong skill if:**
- User wants v5.x handler-style API → `skills/build-signals-agent/`
- User wants creative transforms → `skills/build-decisioning-creative-template/`
- User wants to sell media inventory → `skills/build-seller-agent/`

## The whole shape (read this first)

A v6.0 signals platform implements two methods:

- **`getSignals(req, ctx) → Promise<GetSignalsResponse>`** — sync catalog discovery. Buyer sends filters; you return the matching signals. No async envelope.
- **`activateSignal(req, ctx) → Promise<ActivateSignalSuccess>`** — sync ack with async lifecycle. Provision the signal onto destination platforms (Snap, Meta, TikTok, etc.); return immediately with `deployments[]` rows in current state (`pending` is valid). Each deployment's eventual `activating` / `deployed` / `failed` flows via `publishStatusChange({ resource_type: 'signal', ... })`.

Both throw `AdcpError` for buyer-fixable rejection.

### Minimal worked example — DataMatrix marketplace

```ts
import {
  AdcpError,
  createAdcpServerFromPlatform,
  publishStatusChange,
  type DecisioningPlatform,
  type SignalsPlatform,
  type AccountStore,
} from '@adcp/sdk/server/decisioning';
import type {
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalSuccess,
  AccountReference,
} from '@adcp/sdk/types';
import { serve } from '@adcp/sdk/server';

interface DataMatrixConfig {
  /** Match-rate floor — signals below this rate to a destination are filtered out. */
  minMatchRate: number;
}
interface DataMatrixMeta {
  workspace_id: string;
}

class DataMatrixPlatform implements DecisioningPlatform<DataMatrixConfig, DataMatrixMeta> {
  capabilities = {
    specialisms: ['signal-marketplace'] as const,
    creative_agents: [],
    channels: [] as const,
    pricingModels: ['cpm'] as const,
    config: { minMatchRate: 0.15 } satisfies DataMatrixConfig,
  };

  accounts: AccountStore<DataMatrixMeta> = {
    resolve: async (ref: AccountReference) => {
      const id = 'account_id' in ref ? ref.account_id : 'dm_default';
      return {
        id,
        name: 'DataMatrix default',
        status: 'active',
        operator: 'datamatrix.example.com',
        metadata: { workspace_id: `ws_${id}` },
        authInfo: { kind: 'api_key' },
      };
    },
  };

  signals: SignalsPlatform<DataMatrixMeta> = {
    getSignals: async (_req: GetSignalsRequest): Promise<GetSignalsResponse> => {
      return {
        signals: [
          {
            signal_id: { source: 'agent', agent_url: 'https://datamatrix.example/signals', id: 'in_market_auto' },
            signal_agent_segment_id: 'dm_seg_auto_001',
            name: 'In-Market: Auto Buyers',
            description: 'Active automotive shoppers within 90-day purchase window',
            value_type: 'binary',
            signal_type: 'marketplace',
            data_provider: 'DataMatrix',
            coverage_percentage: 18.5,
            deployments: [],
            pricing_options: [
              { pricing_option_id: 'po_cpm_4', model: 'cpm', cpm: 4.0, currency: 'USD' },
            ],
          },
        ],
      };
    },

    activateSignal: async (req: ActivateSignalRequest): Promise<ActivateSignalSuccess> => {
      if (!req.destinations.length) {
        throw new AdcpError('INVALID_REQUEST', {
          recovery: 'correctable',
          message: 'destinations must be non-empty',
          field: 'destinations',
        });
      }
      // Sync ack: return deployments in `pending` state. Identity-graph
      // match runs in background; publishStatusChange fires when each
      // destination reaches activating / deployed / failed.
      const deployments = req.destinations.map(d => ({
        type: 'platform' as const,
        platform: 'platform' in d ? d.platform : 'unknown',
        account_id: 'account_id' in d ? d.account_id : undefined,
        is_live: false,
      }));

      // Schedule background activation for each destination
      const accountId = req.account && 'account_id' in req.account ? req.account.account_id : 'dm_default';
      for (const dep of deployments) {
        setTimeout(() => {
          publishStatusChange({
            account_id: accountId,
            resource_type: 'signal',
            resource_id: req.signal_agent_segment_id,
            payload: { platform: dep.platform, status: 'deployed', is_live: true },
          });
        }, 100).unref?.();
      }

      return { deployments };
    },
  };
}

const platform = new DataMatrixPlatform();
const server = createAdcpServerFromPlatform(platform, {
  name: 'datamatrix',
  version: '1.0.0',
  validation: { requests: 'strict', responses: 'strict' },
});
serve(() => server, { publicUrl: 'https://datamatrix.example.com' });
```

## Sync ack with async lifecycle

`activateSignal` is **always sync at the wire level** — `ActivateSignalResponse` has no `Submitted` arm. For platforms with slow identity-graph matches (5-30 min) or destination provisioning (hours), the canonical pattern is:

1. Return `ActivateSignalSuccess` immediately with each deployment row in `pending` state
2. Run the activation pipeline in background
3. Emit `publishStatusChange({ resource_type: 'signal', ... })` for each deployment as it reaches `activating` / `deployed` / `failed`

Buyers subscribe via the resource-update channel to track activation progress.

## Errors — `throw new AdcpError(...)`

Common codes for signals:

| Code | When |
|---|---|
| `'SIGNAL_NOT_FOUND'` | unknown `signal_agent_segment_id` |
| `'POLICY_VIOLATION'` | buyer lacks rights to activate this data |
| `'INVALID_REQUEST'` | missing destinations, unrecognized destination shape, missing pricing_option_id when required |
| `'AUDIENCE_TOO_SMALL'` | activated audience falls below match-rate floor |
| `'RATE_LIMITED'` | upstream identity-graph throttled |

```ts
activateSignal: async (req) => {
  if (!signalCatalog.has(req.signal_agent_segment_id)) {
    throw new AdcpError('SIGNAL_NOT_FOUND', {
      recovery: 'terminal',
      message: `Unknown signal: ${req.signal_agent_segment_id}`,
      field: 'signal_agent_segment_id',
    });
  }
  // ... happy path
}
```

## Idempotency — the framework dedupes; you thread the key downstream

Same pattern as creative-template — see [`build-decisioning-creative-template/SKILL.md`](../build-decisioning-creative-template/SKILL.md) § Idempotency. Pass `req.idempotency_key` into your upstream identity-graph / destination-provisioning API so dedup is end-to-end.

## Capabilities

```ts
capabilities = {
  specialisms: ['signal-marketplace'] as const,    // or 'signal-owned'
  creative_agents: [],                              // not used by signals
  channels: [] as const,                            // not used by signals
  pricingModels: ['cpm'] as const,                  // signals are typically CPM uplift
  config: { /* your platform-specific config */ } satisfies YourConfig,
};
```

## Testing your platform

```ts
import { createAdcpServerFromPlatform } from '@adcp/sdk/server/decisioning';

const platform = new DataMatrixPlatform();
const server = createAdcpServerFromPlatform(platform, {
  name: 'dm-test',
  version: '0.0.1',
  validation: { requests: 'off', responses: 'off' },
});

const result = await server.dispatchTestRequest({
  method: 'tools/call',
  params: {
    name: 'get_signals',
    arguments: {
      filters: { catalog_types: ['third_party'], industries: ['automotive'] },
      account: { account_id: 'test_acc' },
    },
  },
});
console.log(result.structuredContent);
```

## What NOT to do

❌ **Don't import from `@adcp/sdk/server` for the platform shape.** Use `@adcp/sdk/server/decisioning` for v6.0.

❌ **Don't try to make activateSignal HITL.** The wire response has no `Submitted` arm. Sync ack + `publishStatusChange` is the correct pattern.

❌ **Don't return error envelopes manually.** Throw `AdcpError`; the framework projects to wire shape.

❌ **Don't write `as any` / `as never` in adopter code.** The wire types are typed; discriminators on `SignalID` (`source: 'catalog' | 'agent'`) and `Destination` (`type: 'platform' | ...`) narrow without casts.

## Reference: imports cheat sheet

```ts
// From @adcp/sdk/server/decisioning
import {
  AdcpError,
  AccountNotFoundError,
  createAdcpServerFromPlatform,
  publishStatusChange,
  type DecisioningPlatform,
  type AccountStore,
  type Account,
  type SignalsPlatform,
  type RequestContext,
  type ErrorCode,
  type AdcpStructuredError,
} from '@adcp/sdk/server/decisioning';

// From @adcp/sdk/types — wire schemas (auto-generated)
import type {
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalSuccess,
  AccountReference,
} from '@adcp/sdk/types';

// From @adcp/sdk/server — HTTP serving
import { serve } from '@adcp/sdk/server';
```
