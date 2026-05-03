---
"@adcp/sdk": minor
---

Add `Account.mode` convention + sandbox-authority helpers from `@adcp/sdk/server`.

Phase 1 of the three-account-mode rollout (see `docs/proposals/lifecycle-state-and-sandbox-authority.md`). Establishes the type and the gate primitive; auto-wiring into the comply controller dispatch lands alongside mock-mode routing in Phase 2 (#1435).

New surface:

- `AccountMode` type — `'live' | 'sandbox' | 'mock'`. Resolved-account convention; default `'live'` when unspecified (fail-closed).
- `getAccountMode(account)` — reads `mode` off any account-shaped value, with back-compat for legacy `sandbox: boolean`.
- `isSandboxOrMockAccount(account)` — predicate: is the account non-production?
- `assertSandboxAccount(account, opts?)` — throws `AdcpError('PERMISSION_DENIED')` (with `details: { scope: 'sandbox-gate' }`) for live-mode or missing accounts. Use to gate test-only surfaces.

Pure additive: existing `account.sandbox === true` adopters keep working — the helpers infer `mode: 'sandbox'` from the legacy flag automatically. No behavior change for shipped code.

Adopters who want stronger gating today can wire `assertSandboxAccount(ctx.account, { tool: 'comply_test_controller' })` inside their `sandboxGate(input)` (after resolving the account). Phase 2 ships SDK-side auto-wiring so this becomes invisible.
