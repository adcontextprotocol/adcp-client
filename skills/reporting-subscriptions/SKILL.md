---
name: reporting-subscriptions
description: Serve or subscribe to AdCP 3.3 principal-level reporting subscriptions (experimental media_buy.reporting_subscriptions) with @adcp/sdk. Use when a seller enables subscriptions on its Reliable Reporting service, when a buyer registers, changes or removes a reporting subscription, or when code calls syncPrincipal with reporting_subscriptions or reporting_destinations, accounts.ensure, or reporting storage and migrations.
---

# Reporting subscriptions (AdCP 3.3, experimental)

A buyer registers reporting once on its principal (`sync_principal`), and the subscription follows its grants across every account. Wire payloads stay snake_case exactly as in the spec; only method and option names are camelCase.

## Buyer: the five calls

```ts
await client.reporting.subscribe(subscription, { registerDestination }); // upsert one; version chosen for you
await client.reporting.unsubscribe('pacing-hourly'); // the only deactivation path
await client.reporting.listSubscriptions(); // states
await client.reporting.preview(subscription); // seller dry run + offeringIds
const outcome = await client.accounts.ensure(key, { billing: 'operator' }); // ready | pending | ambiguous | rejected
```

`client.reporting.replaceSubscriptions(list, { deactivateOmitted: true })` is the expert complete-set write; `[]` needs `deactivateAll: true`. `client.reporting.reconcile()` lists every owed period with its status, reason and responsible party; `client.reporting.explain({ accountId, period })` returns `CoverageTrace`s. `client.reporting.poll()` returns the events since the last `batch.ack()` (call `ack()` after handling; ids are deterministic, so deduplicate on `event.id`); `events({ signal })` is the loop; `handleWebhook(VerifiedWebhook.fromOutcome(verification, body))` is a doorbell, and a webhook body is never event content. Receipts: never send one on read. `reconcile({ receipts: { mode: 'verified', commit } })` receipts after the SDK verified the revision and your `commit` returned `{ commitRef }`; billing lines without a receipt read `receipt: { status: 'owed_by_buyer' }`. Never auto-accept adjustments.

## Seller: one block

```ts
import { postgresStorage } from '@adcp/reporting-storage'; // memoryStorage() from '@adcp/sdk/storage' in development

const reporting = createReliableReportingService({
  storage: postgresStorage({ pool, acknowledgeIsolatedDatabase: true }),
  ...producerConfig,
  subscriptions: { principal: { agentUrl, notifications, resolvePrincipal }, maxAccounts: 500 },
});
const server = createAdcpServerFromPlatform(reporting.install(platform), { protocol: reporting.principals!.protocol });
```

Run `npx adcp-reporting-storage migrate` before starting a release. The service reconciles on writes and sweeps in `runCycle`; you do not call the engine.

## Do / don't

| Don't                                                                                                                                                          | Do                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw `syncPrincipal({ configuration: { reporting_subscriptions: [newOne] } })`: every omitted subscription is deactivated and every omitted destination revoked | `client.reporting.subscribe(newOne)`. The raw call is refused with `SUBSCRIPTION_WOULD_DEACTIVATE` / `DESTINATION_WOULD_REVOKE` unless you pass `allowDeactivation` / `allowRevocation` |
| Omit `subscription_version` or forget to bump it                                                                                                               | Let `subscribe` choose it                                                                                                                                                               |
| `scope: {}`, or rely on an implicit all-accounts scope                                                                                                         | `scope: { all_authorized_accounts: true }` or `{ account_ids: [...] }`, plus `operator_domains` for agencies                                                                            |
| Compute periods with `new Date()` and local time                                                                                                               | Read owed periods from the SDK (`client.reporting.reconcile` / `explain`); never default a timezone                                                                                     |
| Treat a pending account as an error and retry with a new key                                                                                                   | Switch on `outcome.kind` and `nextStep(outcome)`; a repeat `ensure` returns the open request                                                                                            |
| Fetch `pending_action.url`                                                                                                                                     | Show it to a person: `formatPendingAction(outcome.action)`                                                                                                                              |
| Revoke a grant to end a relationship                                                                                                                           | `windDownGrant(account.authorization)` keeps reconciliation tasks                                                                                                                       |
| Set `authorized_at` to now on a re-grant, or compute the chain                                                                                                 | The SDK's grant journal is the only source of `authorized_at`                                                                                                                           |
| Pass `durability: 'durable'` to a store                                                                                                                        | Durability is read from the store; use `memoryStorage()` / `postgresStorage({ pool })`                                                                                                  |
| Call `engine.reconcile` from request handlers                                                                                                                  | Use the managed `subscriptions` block (the engine is rung 3, `@adcp/sdk/reporting/advanced`)                                                                                            |

## Read next

- `docs/guides/REPORTING-SUBSCRIPTIONS-SELLER.md` and `docs/guides/REPORTING-SUBSCRIPTIONS-BUYER.md`
- `docs/guides/REPORTING-SUBSCRIPTIONS-COVERAGE.md`, `-ERRORS.md` and `-MIGRATION.md`
- `docs/guides/FIRST-CALL-TO-A-SELLER.md` for `accounts.ensure` outcomes
- `docs/guides/REPORTING-LEDGER.md` for the building blocks
