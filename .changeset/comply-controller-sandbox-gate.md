---
"@adcp/sdk": minor
---

Auto-wire the framework-side sandbox-authority gate inside `createAdcpServerFromPlatform`. Phase 2 of #1435.

The framework now bypasses `controller.register(server)` for `comply_test_controller` and registers the tool itself, threading `extra.authInfo` through `platform.accounts.resolve` BEFORE dispatching. Under no circumstances does the controller operate on a `live`-mode account, regardless of what the caller claims on the wire — the resolved account is the trust boundary, not buyer-supplied flags like `account.sandbox === true`.

What the gate does, in order:

1. **`list_scenarios` is exempt** — capability probe, no state mutation.
2. **Resolve the account** through `platform.accounts.resolve(ref, { authInfo, toolName })`. Reads the ref from top-level `account` (extended shape) or `context.account` (canonical AdCP routing).
3. **Admit when** the resolved account's `mode` is `'sandbox'` or `'mock'` (legacy `sandbox: true` honored).
4. **Admit when** no account resolves AND `context.sandbox === true` (migration window).
5. **Admit when** `process.env.ADCP_SANDBOX === '1'` (deprecated env-fallback for back-compat).
6. **Otherwise refuse** with a `FORBIDDEN` controller envelope.

**Fail-closed guard on the env fallback.** `ADCP_SANDBOX=1` was never meant to coexist with a resolver that names live accounts. The framework tracks every explicit `mode` value returned from `platform.accounts.resolve` in this process; if `ADCP_SANDBOX=1` is set AND any live-mode account has been resolved, the gate THROWS loudly so operators notice in their logs. Remove `ADCP_SANDBOX` from your prod env and gate via `mode: 'sandbox'` on resolved accounts instead.

**Back-compat.** Existing test platforms relying on `process.env.ADCP_SANDBOX === '1'` continue to work without modification — the env-fallback admits when the resolver doesn't stamp an explicit mode. Implicit-default-to-live (legacy adopter shape) does NOT trip the fail-closed guard; only deliberate `mode: 'live'` from the resolver does.

**Migration path.** Stop setting `ADCP_SANDBOX` in production. Stamp `mode: 'sandbox'` (or `'live'`) on accounts your `accounts.resolve` returns; the gate then enforces strictly without the env fallback. The fallback emits no warning yet — a future minor will warn on each gate-permission grant; a future major will remove it entirely.

Non-MCP transports (rare) keep the v5 behavior: when `getSdkServer(server)` returns null, the controller's own `register(server)` runs and the gate is a no-op for that surface. The gate is an MCP-side concern; A2A and other transports are wired separately.
