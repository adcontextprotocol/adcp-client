# Existing-app reliable reporting buyer

[`worker.mjs`](./worker.mjs) runs the buyer reconciliation loop and a signed
notification receiver. It uses the public `@adcp/sdk/reporting/consumer` and
`@adcp/sdk/signing/server` imports. Wire it to your application's real seller
client, PostgreSQL pool, committed reporting schedule, resource credentials,
and trusted seller signing-key registry. It never invents expected periods from
the seller's status response.

Create a bindings module in your application that exports:

```js
export default {
  db: applicationPostgresPool,
  namespace: 'buyer-billing-production',
  migrate: process.env.BUYER_REPORTING_MIGRATE === '1',
  replaySweepBatchSize: 10000,
  port: 8080,
  publicWebhookUrl: 'https://buyer.example.com/webhooks/reporting',
  // listenPath: '/webhooks/reporting', // set when a proxy strips a public prefix
  jwks: trustedSellerJwksResolver,
  revocationStore: trustedSellerRevocationStore,
  scopeForVerifiedKey: keyid => sellerSigningKeyRegistry.consumerScopeFor(keyid),
  accounts: [
    {
      consumerScope: 'seller.example|buyer-principal-1', // stable, non-secret authenticated pair
      accountId: 'account-1',
      seller: applicationSellerClient, // official AdCP client with reporting methods
      request: { account: { account_id: 'account-1' } },
      expectedPeriods: await buyerCommitmentStore.loadExpectedPeriods('account-1'),
      credentialProvider: buyerDestinationCredentialProvider,
      manifestInspectorOptions: {
        referenceAllowedOrigins: ['https://schemas.seller.example'],
        consumerCommitRef: 'buyer-commitment-2026-09',
      },
      evaluateAdjustment: async ({ adjustment, revision, signal }) =>
        buyerAdjustmentPolicy.decide({ adjustment, revision, signal }),
    },
  ],
  metrics: {
    recordResult: fields => applicationMetrics.recordReportingResult(fields),
    recordError: fields => applicationMetrics.recordReportingError(fields),
  },
};
```

The named values above come from your application; bind them to its actual
modules and retained data. `expectedPeriods` must be the buyer's complete
committed denominator for the requested scope. If an account has no expected
periods, use `[]` only when the buyer independently knows that is correct.
Keep signing key IDs unique across sellers in the trusted JWKS and scope
registry. Never merge untrusted sellers' JWKS entries by key ID with
last-writer-wins behavior: a colliding key could be attributed to the wrong
seller. Resolve both the verification key and `consumerScope` from the same
trusted registration.
The adjustment callback must implement your commercial acceptance policy;
the SDK validates integrity separately. Use an official SDK seller client,
such as the application's existing generated agent client, rather than a
custom HTTP transport.

With the bindings in place:

```bash
npm install @adcp/sdk@^14.0.0-0 pg
BUYER_REPORTING_MIGRATE=1 BUYER_REPORTING_BINDINGS_MODULE=/absolute/path/to/buyer-bindings.mjs \
  node node_modules/@adcp/sdk/examples/reliable-reporting-buyer/worker.mjs
# After the one-process migration, start regular replicas without the migration flag:
BUYER_REPORTING_BINDINGS_MODULE=/absolute/path/to/buyer-bindings.mjs \
  node node_modules/@adcp/sdk/examples/reliable-reporting-buyer/worker.mjs
```

The deployment process runs PostgreSQL persistence and replay migrations
before serving traffic. Regular replicas probe the durable consumer stores,
then start polling and the HTTP receiver. The worker sweeps expired replay
nonces in bounded batches; tune `replaySweepBatchSize` to your webhook rate. The
HTTP boundary verifies the exact raw webhook body under RFC 9421 before
parsing or routing it. A trusted key lookup selects `consumerScope`; no
identity is accepted from the body. Lease contention and transient failures
return 503 with `Retry-After`. Background results and errors emit structured
fields without error messages, request bodies, or credentials. SIGINT and
SIGTERM stop the receiver and wait for in-flight reconciliation before closing
the application-owned pool.

When committed expectations or seller onboarding change, load the complete
buyer roster again and call `worker.replaceAccounts(nextAccounts)`. In-flight
runs finish with their original configuration. An authenticated but unmatched
notification is acknowledged with 204; the poll loop remains the repair path.
