# Testing with the reporting test kit

`@adcp/sdk/testing/reporting` runs a managed reference seller in process, on a virtual clock, with buyers bound to it and the levers coverage depends on. The Python SDK's guide has the same title and sections.

## Testing today

Unit-test your own pieces against the vectors and the in-process seller:
- `owedSubscriptionPeriodsV1` and `explainSubscriptionCoverageV1` (`@adcp/sdk/reporting/advanced`) over your inputs;
- `createReliableReportingService({ storage: memoryStorage(), subscriptions })` under `NODE_ENV=test`, driven with `runCycle({ now, deploymentWide: true })`;
- the storyboard against a running seller: `npx adcp storyboard run http://localhost:3000/mcp --storyboards reporting_subscriptions`.

## The test kit

```ts
import { createReportingTestKit, offerings, reportingTestStart } from '@adcp/sdk/testing/reporting';

const kit = createReportingTestKit({
  start: reportingTestStart(30), // the virtual clock never passes the real one
  offerings: [offerings.dailyAnalytics()],
  accounts: [{ account_id: 'acc_a', timezone: 'America/New_York', grants: ['agency-x'] }],
  buys: [{ media_buy_id: 'mb_1', account_id: 'acc_a', confirmed_at, start_time, end_time }],
});

const buyer = kit.buyer('agency-x'); // client.reporting over the in-process seller
await buyer.reporting.subscribe(analyticsDaily);
await kit.clock.advance('P3D'); // runs the seller's cycle at every period boundary crossed
await kit.grants.revoke('agency-x', 'acc_a');
await kit.clock.advance('P1D');
await kit.grants.regrant('agency-x', 'acc_a');
await kit.grants.windDown('agency-x', 'acc_a'); // or reduce(buyer, account, tasks)
kit.accounts.setTimezone('acc_a', 'America/Los_Angeles');
kit.buys.cancel('mb_1');

await kit.assertAgreement('agency-x'); // the seller's frozen owed set == the buyer's reconcile
```

- **`assertAgreement(buyer)`** compares the engine's frozen owed set with the owed lines of `client.reporting.reconcile()` from the wire, over every period the seller has frozen. On a difference it throws with the differing periods and, for the first few, the first differing rule from `diffCoverageTraces` of the buyer's and the seller's traces.
- **The clock.** `advance(duration)` and `advanceTo(instant)` run `runCycle` at every period boundary crossed, so each period is frozen and produced by the cycle that follows its end. The virtual clock may run past the real clock: under `NODE_ENV=test` (or `development`) the service hands each cycle's `now` to the inline source executor, so periods that have not ended in real time are produced too. Outside those environments the executor refuses a simulated clock.
- **The seller** is `createReferenceReportingSeller(options)`, the same managed composition as the [reference seller](../../examples/reporting-subscriptions-seller/seller.mjs): `memoryStorage()`, a platform serving `accounts.list` (timezone, grant) and `getMediaBuys`, and a source adapter reporting one impression per buy per period. `kit.service` is the Reliable Reporting service, so `kit.service.explainCoverage(...)` works too.
- **`withReportingTestKit(options, async kit => { ... })`** runs a test body against a fresh kit, for `node:test` or vitest.

## The reference seller

`npx adcp reference-seller reporting [--port 3000]` serves the reference seller locally with a seeded account and buy, running its cycle every minute. Any bearer token is the caller's principal id:

```
npx adcp reference-seller reporting --port 3000
npx adcp reporting reconcile --agent http://127.0.0.1:3000/mcp --auth agency-x
```

Python sellers run the TypeScript storyboard CLI against their URL:

```
npx adcp storyboard run https://seller.example/mcp --storyboards reporting_subscriptions --auth "$TOKEN"
```

## Storyboards: owed periods and the conformance probe

**`check: owed_periods_match`** (experimental). On a `get_reporting_status` periods-view step for one account, the runner computes the owed set and compares it with the seller's obligations:

- It computes the periods `subscription_id` owes that account from wire state alone. It reads `get_principal` (paging `prior_versions`), `list_accounts`, `get_media_buys` and `get_adcp_capabilities`, plus this response's `subscription_coverage` entry, and evaluates them with the SDK coverage function at `now = ledger_as_of`.
- It compares that set with the response's obligations for the subscription, one per (version, offering, period), with the same `media_buy_ids` and `stub` flag.
- It compares over one window (AdCP 3.3.0-beta.4). The window starts at the later of the request's `period.start` (no lower bound when absent) and `scope.ledger_retained_from`, where `ledger_retained_from` is capped at `ledger_as_of` minus `status_retention_days`: the seller keeps obligations queryable at least that long. Periods that start before the window are dropped from both sides, so an owed one is not required and a returned one is not a mismatch. Inside the window, a missing or extra obligation fails, and the failure names the window start and the bound that set it (`expected_start`, `ledger_retained_from` or `retention_cap`). When the request sets a period, only periods ending inside it are compared.
- A response with `pagination.has_more` fails as unverifiable.

```yaml
- check: owed_periods_match
  subscription_id: analytics-daily
  severity: advisory
  expires_after_version: "17.0.0"
```

**`comply_test_controller` scenario `reporting_subscription_probe`** (experimental) drives what coverage depends on but a buyer can't change itself:

| Operation | Effect |
|---|---|
| `revoke_grant` | Revokes the caller's own grant on a sandbox account. |
| `regrant` | Restores it, and returns `chain` (`continued` or `new`). |
| `reduce_grant` | Replaces the grant's `allowed_tasks`. Without `get_reporting_status` it is a loss of authority: the account is listed in `accounts_unauthorized[]` and `get_reporting_status` refuses it with `SCOPE_INSUFFICIENT`. |
| `set_account_timezone` | Changes the account's timezone, and returns `SetAccountTimezoneResult`: `simulated_now`, `account_id`, `previous_timezone`, `timezone`, `changed_at` (absent when nothing changed) and `timezone_cutovers: [{ offering_id, previous_timezone, timezone, effective_at }]`, one per account-timezone offering. |
| `advance_time` | Advances the sandbox clock. |

- **Wiring it.** Pass `complyTest.reportingSubscriptionProbe` and `complyTest.resetState` to `createAdcpServerFromPlatform`. Params arrive validated (`reportingSubscriptionProbeParamsError`), and both scenarios are advertised in `list_scenarios` and `compliance_testing.scenarios`.
- **`reset_state` is required with the probe** (AdCP 3.3.0-beta.4). `createComplyController` refuses a `reportingSubscriptionProbe` without `resetState`. The runner calls `reset_state` before each storyboard. It must unpin the caller's sandbox clock, so `simulated_now` reads your wall clock again until the next `advance_time`, and discard every grant and timezone change the probe made for the caller. A plain `TestControllerStore` advertises it through `resetState()`.
- **The test kit's seller implements both.** Its `reset_state` unpins the sandbox clock, so `simulated_now` reads the wall clock until the next `advance_time` pins it again. The kit has one clock for its seller, so the reset unpins it for every caller. The kit keeps the accounts the caller's probe changed and undoes the changes: it restores their grants and timezones, and puts the engine's account records back to their state before the probe's first change, which discards the coverage history the changes recorded. Under `NODE_ENV=test` the clock may run past real time. `kit.buys.addPackage(mediaBuyId, pkg)` adds a package to a buy with `added_at` at the kit's clock.

**`npx adcp reporting doctor --agent <url>`** checks the wiring a buyer can see:
- offerings with `standard_dimensions`, the `subscriptions` block and `status_retention_days`;
- `get_principal`;
- every account's IANA `timezone` and `authorization.authorized_at`;
- `get_media_buys`;
- whether the probe is advertised.

Every failure names a fix. `runReportingDoctor(client)` from `@adcp/sdk/testing/reporting` returns the same checks.
