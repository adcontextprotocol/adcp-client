---
'@adcp/sdk': patch
---

`skills/call-adcp-agent/SKILL.md` — worked example for `decideRetry`.

Closes the documentation gap left over from #1156 (the `BuyerRetryPolicy` helper). The skill now shows adopters end-to-end how to wire `decideRetry` into a buyer agent retry loop — including the same-vs-fresh `idempotency_key` rule, jitter on mutate-and-retry, and per-vertical overrides via `BuyerRetryPolicy`.

Two code blocks added:

1. **Default usage** — `decideRetry(error, { attempt })` with `switch`-style branching on the discriminated `RetryDecision`. Shows TypeScript narrowing each branch (delay only on retry, field/suggestion only on mutate-and-retry, message only on escalate) so adopters can't accidentally hold the same `idempotency_key` after a payload mutation.

2. **Per-vertical override** — `BuyerRetryPolicy` instantiation pattern with a `CREATIVE_REJECTED` override demonstrating how a creative-template platform can convert format-mismatch rejections to in-loop mutate-and-retry while keeping brand-safety rejections as escalate.

Skills are bundled with the npm package, so this is a publishable change.
