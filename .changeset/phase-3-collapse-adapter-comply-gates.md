---
"@adcp/sdk": patch
---

Collapse `examples/hello_seller_adapter_guaranteed.ts` onto the framework-side comply gate (Phase 3 of #1435).

The Hello seller-guaranteed adapter no longer carries any in-adapter `comply_test_controller` gate logic — it's a worked example of the zero-boilerplate posture Phase 2 made possible.

Three changes:

1. **`accounts.resolve` synthesis branch** — the `if (ref.sandbox === true && process.env.ADCP_SANDBOX === '1')` cascade-scenario synthesis now gates only on `ref.sandbox === true` (the spec-defined `AccountReference.sandbox` flag) and stamps `mode: 'sandbox'` on the returned `Account`. The framework gate's resolver-path admit fires on that mode; no env var is consulted.
2. **HITL bypass** — `ctx.account.id.startsWith(SANDBOX_ID_PREFIX) && process.env.ADCP_SANDBOX === '1'` is now `getAccountMode(ctx.account) === 'sandbox'`. Same trust signal, no env var, more robust against any production account whose id happens to share the sandbox prefix.
3. **`complyTest:` opts** — dropped `sandboxGate: () => process.env.ADCP_SANDBOX === '1'`. Phase 2's framework gate is strictly stronger; the in-adapter callback was redundant.

`test/examples/hello-seller-adapter-guaranteed.test.js` no longer sets `ADCP_SANDBOX: '1'` in `extraEnv`. The storyboard now passes purely on the resolver-stamped mode.

**Other Hello adapters were already clean.** `hello_seller_adapter_social.ts`, `hello_seller_adapter_multi_tenant.ts`, and `hello_creative_adapter_template.ts` did not wire the controller. `hello_signals_adapter_marketplace.ts` uses the lower-level `registerTestController` (which Phase 2's gate doesn't intercept) and is left on the legacy path; migration to `complyTest:` opts is non-mechanical because the recorder integration would need a comply-adapter shape upstream.

**Mock-server is unchanged.** Account synthesis happens inside the Hello adapter's `resolve`; the mock-server is only the upstream HTTP backend (returns `network_code` / `operator_id`). Stamping `mode: 'sandbox'` lives in the resolver, where it belongs.

**Existing legacy-path coverage retained.** `test/server-decisioning-comply-test.test.js` continues to exercise the `process.env.ADCP_SANDBOX === '1'` admit path so the deprecated env-fallback bridge stays tested through its life.
