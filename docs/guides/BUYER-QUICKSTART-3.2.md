# Call a seller with AdCP 3.2

Requires Node.js `^20.19.0 || >=22.12.0`. Install the SDK 14 prerelease
and create one client:

```bash
npm install '@adcp/sdk@^14.0.0-0'
```

```ts
import { randomUUID } from 'node:crypto';
import { ADCPMultiAgentClient } from '@adcp/sdk';

const account = { account_id: process.env.SELLER_ACCOUNT_ID! };
const client = ADCPMultiAgentClient.simple(process.env.SELLER_URL!, {
  authToken: process.env.ADCP_TOKEN,
});
const seller = client.agent('default-agent');
```

Set `SELLER_URL` to the seller's MCP endpoint, `ADCP_TOKEN` to a credential
the seller issued, and `SELLER_ACCOUNT_ID` to an account that credential may
use. Obtain all three from the seller; account references are seller-scoped.

## Direct purchase

Read the current feed, retain its version, then buy an offer from that exact
snapshot. The SDK auto-generates a key when one is omitted, which protects its
in-invocation transport retries. For crash or ambiguous-timeout recovery,
generate and persist your own key before the first call, then reuse that exact
key with the same payload.

```ts
const listed = await seller.listProducts({
  account,
  brand: { domain: 'advertiser.example' },
});
if (!listed.success || listed.status !== 'completed') throw new Error(listed.error ?? listed.status);

const product = listed.data.products[0];
const pricing = product?.pricing_options?.[0];
if (!product || !pricing) throw new Error('Seller returned no purchasable products');

const purchaseIdempotencyKey = randomUUID();
// Persist purchaseIdempotencyKey with your pending purchase before sending.
const endTime = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
const bought = await seller.buyProducts({
  idempotency_key: purchaseIdempotencyKey,
  account,
  brand: { domain: 'advertiser.example' },
  feed_version: listed.data.feed_version,
  purchases: [{
    product_id: product.product_id,
    pricing_option_id: pricing.pricing_option_id,
    budget: 5_000,
  }],
  start_time: 'asap',
  end_time: endTime,
});

// A direct buy may be completed immediately or become a submitted task.
const settled = bought.status === 'submitted' ? await bought.submitted!.waitForCompletion() : bought;
if (!settled.success || settled.status !== 'completed') {
  throw new Error(settled.error ?? `Purchase is ${settled.status}; inspect the task or follow its recovery path`);
}

const pauseIdempotencyKey = randomUUID();
// Persist pauseIdempotencyKey with this control attempt before sending.
const pauseRequest = await seller.controlMediaBuy({
  idempotency_key: pauseIdempotencyKey,
  account,
  media_buy_id: settled.data!.media_buy_id,
  revision: settled.data!.revision,
  paused: true,
});
const paused = pauseRequest.status === 'submitted'
  ? await pauseRequest.submitted!.waitForCompletion()
  : pauseRequest;
if (!paused.success || paused.status !== 'completed') throw new Error(paused.error ?? paused.status);

const readback = await seller.getMediaBuys({
  account,
  media_buy_ids: [settled.data!.media_buy_id],
});
if (!readback.success || readback.status !== 'completed') throw new Error(readback.error ?? readback.status);
console.log({ mediaBuy: readback.data!.media_buys[0], nextRevision: paused.data!.revision });
```

`control_media_buy` only changes actions permitted by the accepted terms. If a
change exceeds that commercial envelope, request and accept an amendment
proposal instead. Every mutating attempt needs its own persisted idempotency
key. For longer-running work, retain the returned submitted task handle or
configure `push_notification_config`; do not issue another control request
until the prior mutation is completed and you have its current revision.

## Negotiated purchase

The proposal path is:

```text
request_proposals → refine_proposals → accept_proposal
```

`accept_proposal` requires the committed proposal's `proposal_id`; pass its
`terms_digest` back as `proposal_terms_digest`. Never reconstruct or edit
those values locally. See the
[type summary](../TYPE-SUMMARY.md#request_proposals) for exact request shapes.

For compatibility behavior with AdCP 3.0/3.1 sellers, see
[Media-buy 3.2 compatibility](./MEDIA-BUY-3.2-COMPATIBILITY.md).
