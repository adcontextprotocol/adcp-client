# OperationalPlatform — in-process operational contract

`DecisioningPlatform` covers buyer-facing MCP request dispatch:
`platform.sales.updateMediaBuy(req, ctx)` etc., with `ctx` built from
`authInfo` via `AccountStore.resolve` and threading framework concerns
(`state`, `resolve`, `ctxMetadata`, `handoffToTask`).

In-process consumers are different. The price-optimization poller,
audience-sync task poller, scheduled jobs, and the storefront fan-out
path don't have an MCP request to derive auth from. They have a
stored task with an access token (or no token at all, for
server-side internal scans). They cannot honestly satisfy
`RequestContext`.

`OperationalPlatform` is the named contract for that seam.

## When to use

- **Pollers** that scan stored tasks and call upstream APIs on a
  schedule (price stepping, audience-status polling).
- **Storefront fan-out** that translates one buyer request into N
  upstream calls, each with its own resolved tenant.
- **Scheduled jobs** that perform server-side maintenance against
  upstream platforms.

If your code dispatches in response to an MCP request, you want
`DecisioningPlatform`, not this.

## Five methods

```ts
import { defineOperationalPlatform, type OperationalContext } from '@adcp/sdk/server';
import { AdcpError } from '@adcp/sdk/server/decisioning';

interface SnapOpCtx extends OperationalContext {
  advertiserId: string;
  sandbox: boolean;
}

export const snapOperational = defineOperationalPlatform<SnapOpCtx>({
  platformId: 'snap',

  // 1. Synthesize a per-call context from a stored token. The single
  // documented credential-synthesis path outside `AccountStore.resolve`.
  extractContext: async (args, sessionToken, requireAuth = true) => {
    const token = sessionToken ?? String(args.snap_access_token ?? '');
    if (!token && requireAuth) {
      throw new AdcpError('AUTH_REQUIRED', { message: 'No Snap token available' });
    }
    return {
      accessToken: token || undefined,
      advertiserId: String(args.advertiser_id ?? ''),
      sandbox: Boolean(args.sandbox),
    };
  },

  // 2. Required — every operational consumer assumes it.
  updateMediaBuy: async (ctx, request) => {
    return upstream.update(ctx, request);
  },

  // 3. Required.
  getMediaBuyDelivery: async (ctx, mediaBuyId, startTime, endTime) => {
    return upstream.delivery(ctx, mediaBuyId, startTime, endTime);
  },

  // 4. Optional — audience-sync pollers only.
  pollAudienceStatus: async (platformData, accessToken) => {
    const map = new Map();
    for (const audienceId of upstream.listAudiences(platformData, accessToken)) {
      map.set(audienceId, /* ... */);
    }
    return map;
  },

  // 5. Optional — storefront bundle composition only.
  getProducts: async (ctx, brief, contextId, brand, sourceChain) => {
    return upstream.discoverProducts(ctx, { brief, contextId, brand, sourceChain });
  },
});
```

## Three call patterns of `extractContext`

The combined signature `extractContext(args, sessionToken?, requireAuth?)`
serves three distinct callers. Each passes a different combination:

| Caller | `args` | `sessionToken` | `requireAuth` |
|---|---|---|---|
| **Poller** (price opt, audience) | `{}` | stored token | `true` |
| **Storefront fan-out** | scrubbed buyer args | optional master token | `true` |
| **Server-side scan** | `{}` | `undefined` | `false` |

The combined signature matches the v5 `PlatformAdapter.extractContext`
shape so v5 adapters duck-type-satisfy this interface during
migration without a wrapper. Post-migration, the SDK may split
into `synthesizeFromToken` / `synthesizeFromArgs` for tighter
per-caller types — see [#1530](https://github.com/adcontextprotocol/adcp-client/issues/1530)
for the follow-up.

## Errors

Methods throw `AdcpError` for structured rejection — same convention
as `DecisioningPlatform`. Generic thrown `Error` / `TypeError`
propagate to callers; pollers and fan-out code wrap with their own
error classification.

```ts
updateMediaBuy: async (ctx, request) => {
  if (request.canceled && /* already terminal */) {
    throw new AdcpError('NOT_CANCELLABLE', {
      message: 'Media buy cannot be canceled in its current state',
    });
  }
  // ...
},
```

## Composing with `DecisioningPlatform`

Most adopters ship both: a `DecisioningPlatform` for buyer-facing
dispatch and an `OperationalPlatform` for in-process consumers. Both
typically delegate to the same upstream-client module. Keeping them
as separate contracts (rather than one mega-interface) lets each
caller carry only the context it actually has.

```ts
// router.ts (adopter side)
const decisioning: DecisioningPlatform<Config, SnapMeta> = ...;
const operational: OperationalPlatform<SnapOpCtx> = snapOperational;

// MCP dispatch
createAdcpServerFromPlatform(decisioning, opts);

// Poller
const ctx = await operational.extractContext({}, await tokenStore.get(taskId));
const result = await operational.updateMediaBuy(ctx, request);
```

## Credential discipline

`OperationalPlatform.extractContext` is the only credential-synthesis
path outside `AccountStore.resolve`. Apply the same discipline:

- Re-derive bearers per request from a credential store; don't
  embed long-lived secrets in args you persist.
- Treat `args` as buyer-provided input — apply the same scrubbing
  the buyer-facing path does. The storefront fan-out caller
  typically scrubs once before invoking `extractContext` for each
  upstream target.

See [`CTX-METADATA-SAFETY.md`](./CTX-METADATA-SAFETY.md) for the
full discipline.
