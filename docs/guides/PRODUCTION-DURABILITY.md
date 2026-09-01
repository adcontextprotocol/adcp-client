# Production durability checklist

Use this after the compact seller works locally.

- Run `adcp doctor`; for a live capability/schema check, also pass
  `--agent <alias-or-url>`.
- Use PostgreSQL or Redis for idempotency, task state, proposals, and webhook
  delivery. Process-local stores are development-only.
- For PostgreSQL webhooks, construct `createPostgresWebhookRuntime(...)`, run
  both SQL strings in `runtime.migrations.all`, pass `runtime.serverConfig` as
  the server's `webhooks` option, call `runtime.probe()` at startup, and
  schedule bounded `runtime.recoverOnce()` passes.
- Commit business outcomes and `TaskSettlementIntent` rows in the same
  database transaction. Call `applyTaskSettlementIntent(...)`; acknowledge the
  checkpoint only after it returns `settled`.
- Protect webhook bearer/HMAC material through a
  `WebhookAuthenticationAdapter`. The SDK does not own KMS keys.
- Re-derive credentials per request. Never put secrets in `ctx_metadata`; see
  [ctx_metadata safety](./CTX-METADATA-SAFETY.md).
- Configure RFC 9421 signing and SSRF-safe webhook delivery using the
  [signing guide](./SIGNING-GUIDE.md).
- Run [conformance](./CONFORMANCE.md) against the deployed endpoint before
  promotion.

The full task-settlement transaction and recovery model is in
[Durable task settlement](./DURABLE-TASK-SETTLEMENT.md).

## Enabling PostgreSQL push delivery

The generated seller intentionally starts with `webhooks: false`; changing
that manifest field only changes what `adcp doctor` diagnoses. It does not
enable delivery. Wire the runtime first:

```ts
const runtime = createPostgresWebhookRuntime({
  db: pool,
  publisherScope: process.env.ADCP_DEPLOYMENT_NAMESPACE!,
  deliveries: { tableName: 'seller_webhook_deliveries' },
  outbox: { tableName: 'seller_webhook_outbox' },
  signerProvider,
  authenticationAdapter,
});

for (const sql of runtime.migrations.all) await pool.query(sql);
await runtime.probe();

const server = createAdcpServerFromPlatform(platform, {
  name: 'seller-production',
  version: '1.0.0',
  webhooks: runtime.serverConfig,
});

const workerId = process.env.INSTANCE_ID;
if (!workerId) throw new Error('Set INSTANCE_ID to a stable worker identity');
await runtime.recoverOnce({ ownerToken: workerId });
```

Run `recoverOnce()` from your scheduler repeatedly; one call is one bounded
recovery pass. After the runtime, migrations, and scheduler are deployed, set
`webhooks: true` and the matching `webhookTables` names in
`adcp.project.json`. A passing doctor result proves the tables exist; your
deployment smoke must still prove that the scheduler is running and a signed
test delivery reaches its receiver.
