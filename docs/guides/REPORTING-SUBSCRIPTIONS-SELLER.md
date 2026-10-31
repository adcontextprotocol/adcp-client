# Serving reporting subscriptions (seller)

AdCP 3.3 reporting subscriptions (`media_buy.reporting_subscriptions`, experimental) let a buyer register reporting once on its principal through `sync_principal`, instead of once per account through `sync_accounts`. A subscription follows the buyer's grants: when you grant an account, it is covered; when you revoke it, coverage stops.

This guide covers the managed path, where the SDK derives everything from surfaces you already serve. The [Reliable Reporting ledger guide](REPORTING-LEDGER.md#principal-level-reporting-subscriptions-experimental-adcp-33) documents the building blocks underneath. The Python SDK's guide has the same title and sections.

```ts
import { Pool } from 'pg';
import { postgresStorage } from '@adcp/reporting-storage';
import { createReliableReportingService } from '@adcp/sdk/reporting/service';
import { createAdcpServerFromPlatform } from '@adcp/sdk/server';

const storage = postgresStorage({ pool: new Pool(), acknowledgeIsolatedDatabase: true }); // memoryStorage() in development
const reporting = createReliableReportingService({
  storage,
  adapters: { gam: gamAdapter },
  resolveSource,
  resolveCurrency,
  resolveCoverage,
  contact: { name: 'Reporting ops', email: 'reporting@seller.example' },
  automatedRecoveryWindowSeconds: 86_400,
  statusRetentionDays: 400,
  subscriptions: {
    principal: { agentUrl: 'https://seller.example/mcp', notifications, resolvePrincipal },
    maxAccounts: 500,
    configure: ({ offering }) => reportContentFor(offering),
  },
});
const server = createAdcpServerFromPlatform(reporting.install(platform), {
  name: 'acme-seller',
  version: '1.0.0',
  protocol: reporting.principals!.protocol, // get_principal / sync_principal
});
```

## Prerequisites

The SDK reads these surfaces under each principal's identity, so a principal sees exactly what it could see through `get_media_buys`.

| Input | Read from | Must be present | Override |
|---|---|---|---|
| Authorized accounts | the platform's `accounts.list` | `account_id`, `timezone` (IANA), `operator`, `authorization.allowed_tasks` | `subscriptions.accounts` |
| Visible buys | `sales.getMediaBuys` | `confirmed_at`, `start_time`, `end_time`, `cancellation.canceled_at`, `completed_at`, `packages[].package_id` | `subscriptions.buys` |
| Package offerings | every registered offering | | `subscriptions.buyOfferings` |
| Offerings | each adapter's `deliveryOffering` | `standard_dimensions` on every offering | none |
| Report content | `subscriptions.configure(generation)` | metrics, dimensions, source settings | required in TypeScript |

The framework `Account` type has no `timezone` field yet: return `timezone` on the `accounts.list` items. An account without a timezone fails `account_timezone` offerings with `COVERAGE_INPUT_INCOMPLETE`, and is never read as UTC.

## What the SDK derives

- **The principal runtime.** With `storage` and `subscriptions.principal`, the service builds it over `storage.principals` (`reporting.principals`). Otherwise pass yours as `subscriptions.principals`. Either way the service installs the `reporting_subscriptions` section and fills in `capabilities.principal`.
- **Capabilities.** `configuration_tasks` and the `subscriptions` block (`max_accounts`, `backfill_on_regrant`).
- **Scheduling.**
  - A `sync_principal` write that submits `reporting_subscriptions` reconciles that principal (`reconcileOnWrite`, default on). A failed reconcile never fails the write.
  - Each `runCycle` reconciles every subscribed principal, then plans obligations.
- **Grants.** The grant journal (see [Grants and wind-down](#grants-and-wind-down)).
- **Failures.** Reconcile and planning failures are returned in `runCycle().subscriptionPlanningFailures` and passed to `planningErrorHandler`. They never reject a cycle.

## Overrides

Each `subscriptions` field replaces one derivation:
- `accounts(principal, { cursor })` and `buys(principal, accountId)` replace the roster and the buys;
- `buyOfferings(mediaBuy)` replaces package offerings;
- `accountDeliveryConfigs(principal, accountId)` and `endAccountConfigs(...)` enable precedence and `replace_account_configs`;
- `isPeriodDelivered(principal, period)` gives exact withheld counts (it defaults to `false`);
- `resolvePrincipal(ctx)` replaces principal resolution for the reporting tasks.

If your account access depends on a live upstream token, supply `accounts`. A listing that fails under the service context is recorded as `SUBSCRIPTION_ROSTER_UNAVAILABLE`, and is never read as an empty roster.

## Bring your own producer and ledger

Not yet on the managed path. Use the advanced composition from `@adcp/sdk/reporting/advanced`: build the engine with `createReportingSubscriptionEngineV1` and pass `subscriptions: { engine, resolvePrincipal, listSubscriptionPrincipals, resolveSubscriptionConfiguration }`. See the [ledger guide](REPORTING-LEDGER.md#principal-level-reporting-subscriptions-experimental-adcp-33). The bring-your-own-producer option (`producer: 'external'`) arrives in a later beta.

## Grants and wind-down

The SDK is the only source of `authorization.authorized_at`.
- **Chain rule.** A re-grant before `unauthorized_at + status_retention_days` continues the chain, so `authorized_at` does not move. A later re-grant starts a new chain.
- **Projection.** Served `list_accounts` and `sync_accounts` carry the journal's value, which is the value coverage uses. A host value that moves backwards is refused (`authorized_at_regressed`).
- **Push.** `await reporting.grants!.changed({ principal, accountId, at, authorized, allowedTasks })` records a change at the moment your entitlement service knows it.

`authorized_at` is when the *current authorization chain* began, not when access was last granted. Never set it to "now" on a re-grant, and never move it earlier.

**Wind down, don't revoke.** Revocation means no access at all, receipts and statuses included. To end a relationship while the buyer finishes reconciling:

```ts
import { windDownGrant } from '@adcp/sdk/server';

// Keeps get_reporting_status, sync_reporting_receipts and sync_reporting_status, and authorized_at.
account.authorization = windDownGrant(account.authorization);
```

## Storage and migrations

Pass one storage object: `memoryStorage()` from `@adcp/sdk/storage` in development, `postgresStorage({ pool })` from `@adcp/reporting-storage` in production. It holds the ledger, principal records, engine state and grant journal. Process-local storage is refused outside `NODE_ENV=test|development` (`REPORTING_STORAGE_NOT_DURABLE`). Durability is a property of the store, never a flag.

Apply schema changes with `npx adcp-reporting-storage migrate [--status | --dry-run]` before starting a release. The service refuses a schema that is behind before its first cycle (`REPORTING_SCHEMA_BEHIND`, naming the pending versions); call `await storage.checkSchema()` at boot to fail before serving requests. Version `0003` is a stopped-worker upgrade: stop every older reporting worker first. See the [storage package README](https://github.com/adcontextprotocol/adcp-client/blob/main/packages/reporting-storage/README.md#apply-migrations-npx-adcp-reporting-storage-migrate).

## Workers and scaling

Run `reporting.start({ intervalMilliseconds, deploymentWide: true })`, or call `runCycle` from your own scheduler. Workers share the storage; engine state is written by compare-and-set, so several workers agree. Each platform read is bounded by `subscriptions.readTimeoutMilliseconds` (30 seconds by default).

## Telemetry

Today: `planningErrorHandler`, `runCycle().subscriptionPlanningFailures`, the `authorized_at_regressed` log line and `reporting.subscriptionWiring.engine.inspect(principal)` ("what the engine believes"). OpenTelemetry metrics and `reporting.health()` arrive in a later beta.

## Troubleshooting with explain

`reporting.explainCoverage(...)` and the shared `CoverageTrace` arrive in a later beta. Until then, `owedSubscriptionPeriodsV1` from `@adcp/sdk/reporting/advanced` lists the owed periods. Coverage reason codes and SDK error codes come from the canonical vectors in the spec repository (`static/compliance/source/test-vectors/reporting-subscriptions/`).
