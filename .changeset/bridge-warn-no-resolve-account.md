---
'@adcp/sdk': minor
---

feat(server): construction-time warn when `testController` is registered without an account resolver (#1784)

`createAdcpServer` now emits a one-shot `logger.warn` at construction when `config.testController` is present but neither `config.resolveAccount` nor `config.resolveAccountFromAuth` is configured. In that setup, the dispatch-time sandbox gate's account-side check has no teeth — the gate admits requests where `ctx.account === undefined`, so the only remaining check is buyer-supplied `account.sandbox` / `context.sandbox` on the request body, which is caller-controlled and not a trust boundary.

The warn makes that silent misconfiguration loud once at startup, where any logging setup will surface it. It's deliberately not a hard error: storyboard-runner deployments without account scoping are a legitimate and intentional configuration (the runner drives state directly, no buyer authentication path needed), and failing construction would break that case. The warn message tells storyboard runners they can ignore it.

The check gates on `resolveAccountFromAuth` as well as `resolveAccount`, so OAuth-passthrough setups (`createOAuthPassthroughResolver`, the canonical Shape-B adopter path) don't get a spurious warn — either resolver populates `ctx.account` at dispatch time and gives the gate its account-side teeth.

JSDoc on `TestControllerBridge` (in `test-controller-bridge.ts`) and on `AdcpServerConfig.testController` (in `create-adcp-server.ts` § "Security — trust boundary") already document the trust model from #1779 and #1786; this PR adds the runtime equivalent so the failure mode surfaces before an adopter discovers it from a security review or a misconfigured prod deployment.
