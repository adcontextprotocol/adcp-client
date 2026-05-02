---
"@adcp/sdk": patch
---

`tasks_get` now resolves the calling `BuyerAgent` (when an `agentRegistry` is configured) and threads it to `accounts.resolve` as `ctx.agent` — same contract as every other AccountStore call site after #1315 + #1321.

The custom-tool path historically bypassed `BuyerAgentRegistry.resolve` because it sits outside the dispatcher's main handler-dispatch flow, leaving adopters' resolve impls to see `ctx.agent: undefined` on `tasks_get` calls but populated on every other tool. That asymmetry quietly broke the "use `ctx.agent` for principal-keyed gates" guidance the JSDoc on `upsert?` / `reportUsage?` / `getAccountFinancials?` adopted in the prior two releases.

**Status enforcement is deliberately NOT replicated.** A buyer agent suspended *after* kicking off an HITL task must still be able to poll for terminal state — refusing the poll would strand work with no visibility. Sellers who need hard cutoff implement that policy inside their own `accounts.resolve` (read `ctx.agent.status`, throw `AdcpError`). The dispatcher's main path enforces status at request entry; the polling path does not. Tests pin both behaviors.

Registry failures during a poll fall through to `agent: undefined` rather than breaking the poll — same defensive shape as the dispatcher.

No behavior change for adopters who don't read `ctx.agent` from inside their resolver.
