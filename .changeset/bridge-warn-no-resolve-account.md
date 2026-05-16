---
'@adcp/sdk': minor
---

feat(server): construction-time warn when `testController` is registered without an account resolver (#1784)

`createAdcpServer` now emits a one-shot construction-time warning when `config.testController` is present but neither `config.resolveAccount` nor `config.resolveAccountFromAuth` is configured. In that setup, the dispatch-time sandbox gate's account-side check has no teeth — the gate admits requests where `ctx.account === undefined`, so the only remaining check is buyer-supplied `account.sandbox` / `context.sandbox` on the request body, which is caller-controlled and not a trust boundary.

The warning **dual-emits** via `process.emitWarning(message, { type: 'AdcpServerConfigWarning', code: 'ADCP_BRIDGE_NO_RESOLVER' })` AND `logger.warn(message)`. The `process.emitWarning` channel writes to stderr by default so the signal is visible even when `logger` is the default `noopLogger` (the day-one case where the misconfig is most likely). The `logger.warn` channel routes the same signal through any adopter-configured logging pipeline. Storyboard runners that knowingly run without account scoping can silence via `node --no-warnings=ADCP_BRIDGE_NO_RESOLVER`.

It's deliberately not a hard error: storyboard-runner deployments without account scoping are a legitimate and intentional configuration (the runner drives state directly, no buyer authentication path needed), and failing construction would break that case. The warning message tells storyboard runners they can ignore it.

The check gates on `resolveAccountFromAuth` as well as `resolveAccount`, so OAuth-passthrough setups (`createOAuthPassthroughResolver`, the canonical Shape-B adopter path) don't get a spurious warn — either resolver populates `ctx.account` at dispatch time and gives the gate its account-side teeth.

JSDoc on `TestControllerBridge` (in `test-controller-bridge.ts`) and on `AdcpServerConfig.testController` (in `create-adcp-server.ts` § "Security — trust boundary") already document the trust model from #1779 and #1786; this PR adds the runtime equivalent so the failure mode surfaces before an adopter discovers it from a security review or a misconfigured prod deployment.
