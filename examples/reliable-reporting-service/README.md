# Adapter-first Reliable Reporting Core

This is the minimal production assembly. The provider adapter returns only
real upstream results: `null` means not ready, `[]` is an observed zero-row
period, and a populated response carries the provider's rows and temporal
evidence. It never manufactures fallback delivery.

```ts
import { Pool } from 'pg';
import { createAdcpServerFromPlatform } from '@adcp/sdk/server';
import { PostgresReportingLedgerStore } from '@adcp/sdk/reporting/ledger';
import { createReliableReportingService, type ReliableReportingAdapterV1 } from '@adcp/sdk/reporting/service';

// Your provider integration owns these immutable declarations and the real
// bounded API read. The fetch context contains only durable, non-secret
// routing IDs; derive OAuth/bearer credentials inside the provider client.
const providerAdapter: ReliableReportingAdapterV1 = {
  sourceOffering: provider.reportingSourceOffering,
  deliveryOffering: provider.reportingDeliveryOffering,
  fetchSlice: (request, context) =>
    provider.fetchReportingSlice(request, {
      signal: context.signal,
      networkId: String(context.sourceScope.network_id),
    }),
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const reporting = createReliableReportingService({
  store: new PostgresReportingLedgerStore(pool, {
    acknowledgeIsolatedDatabase: true,
  }),
  adapters: { provider: providerAdapter },
  contact: { name: 'Reporting operations', email: 'reporting@example.com' },
  automatedRecoveryWindowSeconds: 86_400,
  statusRetentionDays: 90, // enforce the same or longer retention in the ledger database
  resolveSource: account => ({
    adapterId: 'provider',
    sourceScope: { network_id: account.ctx_metadata.provider.networkId },
    sourceTimezone: account.ctx_metadata.provider.timezone,
  }),
  resolveCurrency: account => account.ctx_metadata.provider.currency,
  // Authorization boundary: the constituents this account may report on, read
  // from your booking system rather than echoed from the buyer's declaration.
  resolveCoverage: async account => ({
    constituents: await bookings.authorizedReportingConstituents(account.id),
  }),
  resolveConsumerId: ctx => {
    if (!ctx.agent) throw new Error('Authenticated buyer-agent registry required');
    return ctx.agent.agent_url;
  },
});

await pool.query(reporting.setup.migrations[0]);
const installedPlatform = reporting.install(platform);
const server = createAdcpServerFromPlatform(installedPlatform, serverOptions);

// Pick exactly one operational ownership model.
reporting.start({
  intervalMilliseconds: 60_000,
  deploymentWide: true,
  maxObligationsPerAccount: 500,
  maxWorkerIterationsPerAccount: 100,
  onError: error => operations.capture(error),
});

process.once('SIGTERM', async () => {
  await reporting.stop();
  await pool.end();
});
```

For tenant-partitioned scheduling, replace `deploymentWide: true` with
`accountIds: () => tenantDirectory.reportingAccountIds()`. A resolver must
return an array; it can never fall back to a deployment-wide scan, and an
empty or missing account ID is refused rather than widened. One account's
failed cycle reaches `onError` without skipping the accounts behind it. Configure an
authenticated `agentRegistry` before using the `ctx.agent` consumer identity
shown above.

`platform.accounts.upsert` must be installed: it is the native
`sync_accounts` implementation advertised by the Core capability. Its
authenticated reporting-configuration path calls `installConfiguration` as
shown below.

During authenticated `sync_accounts` handling, validate the requested
offering and resolve its media-buy/package denominator, then call:

```ts
const frozen = await reporting.installConfiguration(resolvedConfiguration, {
  account: ctx.account,
});
```

`resolvedConfiguration` contains reporting semantics only: no account identity,
source scope, source contract, timezone, currency, `constituents`, or
`mediaBuyIds`. The denominator comes from `resolveCoverage`, so a buyer cannot
name another buyer's media buys on a shared upstream network. The service derives those only from the already-resolved account.
See [the ledger guide](../../docs/guides/REPORTING-LEDGER.md) for the complete
input shape, per-account scheduling, migration from manual wiring, and the
conformance helper.
