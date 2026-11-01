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
- **The clock.** `advance(duration)` and `advanceTo(instant)` run `runCycle` at every period boundary crossed, so each period is frozen and produced by the cycle that follows its end. The virtual clock cannot pass the real clock: the source executor refuses periods that have not ended in real time. Start in the past with `reportingTestStart(days)`.
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
