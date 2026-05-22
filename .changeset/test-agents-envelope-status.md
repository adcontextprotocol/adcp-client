---
---

fix(test): add envelope status to `test-agents/*.ts` (3.1.0-beta.3 sweep)

Same envelope-status sweep we applied to `examples/*.ts` (commit e03dda0b5) and `skills/**/SKILL.md` code samples (commit e482638d4) — `test-agents/*.ts` lagged. With AdCP 3.1.0-beta.2 making envelope `status` required, the test-agents typecheck step in CI's `Run unit tests` job started failing with 9 TS2322/TS2741 errors, masking the actual unit-test results.

**Changes**:

- `seller-agent-signed-mcp.ts` — `getProducts` gains `status: 'completed'`
- `seller-agent.ts` — `syncAccounts`, `getProducts`, `getMediaBuys`, `listCreativeFormats`, `getMediaBuyDelivery` each gain `status: 'completed'` on their response objects (5 sites)
- `seller-agent.ts` — `syncAccounts` adds a narrow cast for `acct.brand` / `acct.operator` since `ProvisioningMode` / `SettingsUpdateMode` are typed as passthrough `Record<string, unknown>` on main (until #1941 lands the typed-fields fix at the next codegen)
- `signals-agent.ts` — `type Signal = GetSignalsResponse['signals'][number]` becomes `NonNullable<GetSignalsResponse['signals']>[number]` (the field is now optional); `getSignals` gains envelope `status: 'completed'`

No runtime/API impact. Pure test-agent catch-up. `npx tsc --noEmit` clean against `test-agents/tsconfig.json`. Part of issue #1943's 3.1.0-beta.3 unit-test sweep — clears the early-bail in the `Run unit tests` step so subsequent test failures can be observed and triaged.
