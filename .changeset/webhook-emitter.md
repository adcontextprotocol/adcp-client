---
'@adcp/client': minor
---

Publisher-side webhook emission — the symmetric counterpart to PR #629's receiver-side dedup.

**New `createWebhookEmitter`** in `@adcp/client/server`. One `emit(url, payload, operation_id)` call and the emitter handles:

- RFC 9421 signing with a fresh nonce per attempt (adcp#2423).
- Stable `idempotency_key` per `operation_id` reused across retries (adcp#2417) — regenerating on retry is the highest-impact at-least-once-delivery bug the runner-side conformance suite catches.
- JSON serialized once with compact separators (`,` / `:`, no spaces) and posted byte-identically — the signature-base input and the wire body come from the same bytes, preventing the Python `json.dumps` default-spacing trap pinned by adcp#2478.
- Retry with exponential backoff + jitter on 5xx / 429. Terminal on 4xx and on 401 responses carrying `WWW-Authenticate: Signature error="webhook_signature_*"` (retrying a signature failure produces identical bytes and identical rejection).
- Pluggable `WebhookIdempotencyKeyStore` (default in-memory) — swap in a durable backend for multi-replica publishers.
- HMAC-SHA256 / Bearer fallback modes for legacy buyers that registered `push_notification_config.authentication.credentials`. HMAC path uses the same compact-separators pinning.

**`createAdcpServer` integration.** New `webhooks?: { signerKey, retries?, idempotencyKeyStore?, ... }` config option. When set, `ctx.emitWebhook` is populated on every handler's context — completion handlers post signed webhooks without constructing the signer, fetching, or tracking idempotency themselves:

```ts
createAdcpServer({
  name,
  version,
  webhooks: { signerKey: { keyid, alg: 'ed25519', privateKey: jwk } },
  mediaBuy: {
    createMediaBuy: async (params, ctx) => {
      const media_buy_id = await persist(params);
      await ctx.emitWebhook({
        url: params.push_notification_config.url,
        payload: { task: { task_id, status: 'completed', result: { media_buy_id } } },
        operation_id: `create_media_buy.${media_buy_id}`,
      });
      return { media_buy_id, packages: [] };
    },
  },
});
```

**Full-stack E2E test.** `test/lib/webhook-emitter-server-e2e.test.js`: `createAdcpServer` with a real handler → `ctx.emitWebhook` → real HTTP POST → receiver captures → `verifyWebhookSignature` accepts. No mocks on the signer or verifier path. Closes the "we haven't spun up an actual server and watched the full stack verify" gap flagged during PR #631 review.

**Exports** from `@adcp/client/server`:

- `createWebhookEmitter`, `memoryWebhookKeyStore`
- Types: `WebhookEmitter`, `WebhookEmitterOptions`, `WebhookEmitParams`, `WebhookEmitResult`, `WebhookEmitAttempt`, `WebhookEmitAttemptResult`, `WebhookIdempotencyKeyStore`, `WebhookRetryOptions`, `WebhookAuthentication`
- `HandlerContext.emitWebhook` — new optional field, populated when `webhooks` config is set.
