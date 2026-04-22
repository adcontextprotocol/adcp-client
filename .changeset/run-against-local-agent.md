---
'@adcp/client': minor
---

Add `runAgainstLocalAgent` to `@adcp/client/testing` — a one-call compliance harness that composes `createAdcpServer` + `serve` + `seedComplianceFixtures` + the webhook receiver + the storyboard runner. Sellers iterating on their handlers no longer need to hand-roll the 300-line bootstrap (ephemeral port, fixtures, webhook receiver, loop, teardown) from `adcp`'s `server/tests/manual/run-storyboards.ts`.

**Programmatic surface.** `@adcp/client/testing` now exports `runAgainstLocalAgent({ createAgent, storyboards, fixtures?, webhookReceiver?, authorizationServer?, runStoryboardOptions?, onListening?, onStoryboardComplete?, bail? })`. The caller's `createAgent` must close over a stable `stateStore` so seeds persist across the factory calls `serve()` makes per request. `storyboards` accepts `'all'` (every storyboard in the cache), `AgentCapabilities` (the same resolution the live assessment runner does), `string[]` (storyboard or bundle ids), or `Storyboard[]`.

**CLI surface.** `adcp storyboard run --local-agent <module> [id|bundle]` is a thin wrapper over the programmatic helper. The module must export `createAgent` as default or named. `--format junit` emits a JUnit XML report on stdout for single-storyboard and `--local-agent` runs — each storyboard becomes a `<testsuite>`, each step a `<testcase>`.

**Test authorization server.** `@adcp/client/compliance-fixtures` now exports `createTestAuthorizationServer({ subjects?, issuer?, algorithm? })` — an in-process OAuth 2.0 AS that serves RFC 8414 metadata, JWKS, and a client-credentials token endpoint. Pairs with `runAgainstLocalAgent({ authorizationServer: true })` to grade `security_baseline`, `signed-requests`, and other auth-requiring storyboards locally without reaching an external IdP. RS256 by default (ES256 available); HS* is refused to match `verifyBearer`'s asymmetric-only allowlist.

**New guide.** `docs/guides/VALIDATE-LOCALLY.md` walks the ten-line pattern, the stable-stateStore rule, the CLI equivalent, and the auth-server integration.

Closes adcp-client#786.
