---
'@adcp/sdk': minor
---

`WireSafe<T>` brand + `pickWireSpecFields` + `scrubExtensions` — the L2 half of #1529's credential-discipline plan. Where L1 (`credentialPolicy`) catches credential-shaped keys at the buyer-facing dispatch boundary, L2 catches structural leakage at the operational fan-out boundary — storefront fan-out code that picks per-target args from a buyer request and forwards them upstream.

```ts
import { pickWireSpecFields, scrubExtensions } from '@adcp/sdk/server';

const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');
// safe: WireSafe<UpdateMediaBuyRequest> — every wire-spec-allowed
// field preserved, every other key (top-level credentials,
// arbitrary attacker payload) dropped.

const perTarget = scrubExtensions(safe, {
  allowedExtKeys: new Set(['scope3_api_key', 'partner_request_id']),
  inject: { context: { managed_access_token: target.token } },
});
await operational.updateMediaBuy(ctxFor(target), perTarget);
```

Wire-spec field allowlists come from codegen (`scripts/generate-wire-spec-fields.ts`) walking `schemas/cache/{version}/` — drift between the helper and the schema is structurally impossible. Codegen covers 29 fan-out-relevant request types (every mutating tool + `get_media_buy_delivery`).

The `WireSafe<T>` brand is type-level only (constructed via `unique symbol`) — adopters who use the helper get the safety benefit at the picking site. `OperationalPlatform` method signatures keep their existing plain-typed parameters so #1530 remains source-compatible. Closes #1529.
