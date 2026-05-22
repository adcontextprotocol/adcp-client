---
---

fix(test): update context-extractor fixtures to use 3.1.0-beta.3 field names (`verdict`, `outcome_state`)

`src/lib/testing/storyboard/context.ts` reads `d.verdict` for `check_governance` and `d.outcome_state` for `report_plan_outcome` — the post-3.1.0-beta.3 wire field names. The test fixtures in `test/lib/context-extractors.test.js` still sent `status:` (the pre-3.1 names), so the extractors saw nothing and returned `{}`, failing every assertion.

3 fixtures updated:

- `check_governance` — `status: 'approved'` → `verdict: 'approved'`
- `check_governance` — `status: 'denied'` → `verdict: 'denied'`
- `report_plan_outcome` — `status: 'completed'` → `outcome_state: 'completed'`

Plus 2 test-description renames (`...and status` → `...and verdict`; `when status is missing` → `when outcome_state is missing`).

No runtime/API impact — pure test-fixture catch-up to 3.1.0-beta.3. Empty changeset satisfies the gate. Part of issue #1943's 3.1.0-beta.3 unit-test sweep.
