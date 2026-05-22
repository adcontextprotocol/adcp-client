---
---

fix(test): update governance test fixtures to 3.1.0-beta.3 `verdict` rename

`parseCheckResponse` and `GovernanceAgentStub` emit `verdict:` for the governance decision (3.1.0-beta.3 envelope/decision split — envelope `status` is now task-state {completed,failed,...}; decision verdict is the operational answer {approved,denied,conditions}). The test fixtures still asserted `status: 'approved'`-shaped output, so every parse/round-trip test failed.

**`test/lib/governance.test.js`** — 5 input-fixture renames in `parseCheckResponse` tests (`status:` → `verdict:`), plus 1 `GovernanceAdapter.checkCommitted` assertion update: now expects both `status: 'failed'` (envelope: not-configured = task failure) AND `verdict: 'denied'` (decision: denied). Added an inline comment explaining the split.

**`test/lib/governance-stub.test.js`** — 3 output-assertion renames (`parsed.status` → `parsed.verdict`) on the MCP/HTTPS stub round-trip checks.

No runtime/API impact — pure test-fixture catch-up. 52/52 across both files pass locally after the change. Empty changeset satisfies the gate.

Part of issue #1943's 3.1.0-beta.3 unit-test sweep (cluster 2, governance).
