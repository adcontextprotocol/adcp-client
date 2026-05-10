---
"@adcp/sdk": patch
---

fix(a2a): sign tasks/cancel POST against signed-requests sellers (#1617 Phase 2)

Phase 1 (`@adcp/sdk@6.16.0`) sent the A2A `tasks/cancel` POST unsigned —
documented limitation. A `signed-requests` seller that enforces signing on
the cancel path would 401 it, defeating the orphan-prevention goal of
cancel-on-abort.

`cancelA2ATask` now takes the full `AgentConfig` and, when
`agent.request_signing` is configured, routes the cancel POST through
`createSigningFetch` (inline keys) or `createSigningFetchAsync` (provider
keys). The signing wrapper is rebuilt per cancel rather than replayed from
`signingContextStorage` — that ALS scope is set around `callA2AToolImpl`
and doesn't extend into `pollTaskCompletion`'s sibling promise tree, so
capture-and-replay isn't viable. Rebuilding from `agent.request_signing`
is equivalent: that's the same source of truth `buildAgentSigningContext`
reads from at submission time.

**Bypass `buildAgentSigningFetch`'s capability gate**: that path consults
the seller's `request_signing.supported_for` to decide whether to sign,
but `tasks/cancel` is an A2A protocol method, not an AdCP tool. Sellers
typically list AdCP tool names there, not protocol-level methods. The
shape that matches actual seller behavior: if the agent claims signing
at all, sign every mutating POST we send. Sellers with uniform "must be
signed" policies accept this; sellers that only check signing on specific
AdCP tools simply ignore the extra signature.

**Test fixture**: in-process loopback HTTP server runs the SDK's own
`verifyRequestSignature` against incoming `tasks/cancel` POSTs (mirrors
what a real signed-requests seller does at the verifier seam). Three
tests: signed-and-accepted, unsigned-still-works (regression guard for
agents without `request_signing`), and bearer-still-attached-on-signed.

Upstream `adcp#4314` requests test-agent add per-session strict-mode
header opt-in so we can also exercise this against the production
fixture once that lands.

**API change**: `cancelA2ATask(agentUrl, taskId, authToken)` →
`cancelA2ATask(agent, taskId)`. Internal helper; no public API impact.
