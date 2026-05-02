---
'@adcp/sdk': minor
---

feat(server): BuyerAgent.sandbox_only — defense-in-depth for test-only agents

Phase 1.5 of #1269 (proposed during review on PR #1320). Adds a `sandbox_only?: boolean` field to `BuyerAgent` plus a framework-level gate.

When `sandbox_only === true`, the framework rejects any request whose resolved `Account.sandbox !== true` with `PERMISSION_DENIED`, `error.details.scope: 'agent'`, `error.details.reason: 'sandbox-only'`, `recovery: 'terminal'`. Composes naturally with `Account.sandbox` from #1256 — same axis at the agent level.

**When to use it.** CI runners, internal QA agents, partner pre-prod environments. If the test agent's credential leaks, blast radius is bounded to sandbox accounts. Production agents leave the field unset (or `false`).

**Gate placement.** Runs after `accounts.resolve` so the framework can compare `agent.sandbox_only` against `account.sandbox`. Runs after Stage 4's status enforcement, so a suspended sandbox-only agent fails with status (not sandbox). Account-less tools (`provide_performance_feedback`, `list_creative_formats`, etc.) pass the gate — the sandbox/production axis doesn't apply when there's no account in scope.

New tests cover: sandbox→sandbox succeeds, sandbox→prod rejected with structured envelope (and the explicit `sandbox: false` variant rejecting the same way as unset), undefined/false `sandbox_only` permissive on both account types (production-agent-on-prod-account explicit), account-less tools pass, status enforcement fires before sandbox-only enforcement, null registry result skips the gate. Full suite green.

Phase 2 (#1292) — framework-level billing-capability enforcement and AdCP-3.1 error-code emission — is still gated on the SDK's 3.1 cutover.
