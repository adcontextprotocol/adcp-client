---
'@adcp/client': minor
---

Bundle the `governance.denial_blocks_mutation` default assertion and auto-register the existing defaults on any `@adcp/client/testing` import (adcontextprotocol/adcp#2639, #2665 closed as superseded).

**New default assertion** (`default-invariants.ts`):

`governance.denial_blocks_mutation` — once a plan receives a denial signal (`GOVERNANCE_DENIED`, `CAMPAIGN_SUSPENDED`, `PERMISSION_DENIED`, `POLICY_VIOLATION`, `TERMS_REJECTED`, `COMPLIANCE_UNSATISFIED`, or `check_governance` returning `status: "denied"`), no subsequent step in the run may acquire a resource for that plan. Plan-scoped via `plan_id` (pulled from response body or the runner's recorded request payload — never stale step context). Sticky within a run: a later successful `check_governance` does not clear the denial. Write-task allowlist excludes `sync_*` batch shapes for now. Silent pass when no denial signal appears.

**Auto-registration wiring**:

`storyboard/index.ts` now side-imports `default-invariants` so any consumer of `@adcp/client/testing` picks up all three built-ins (`idempotency.conflict_no_payload_leak`, `context.no_secret_echo`, `governance.denial_blocks_mutation`). Previously only `comply()` triggered registration; direct `runStoryboard` callers against storyboards declaring `invariants: [...]` would throw `unregistered assertion` on resolve. Consumers who want to replace the defaults can `clearAssertionRegistry()` and re-register.

**Supersedes** #2665 (the sibling `@adcp/compliance-assertions` package proposal): shipping these in-band is the lower-ceremony path and makes storyboards that reference the ids work out of the box against a fresh `@adcp/client` install.
