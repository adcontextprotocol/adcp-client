---
'@adcp/client': patch
---

Clarify idempotency-on-error semantics in the seller and creative skill docs, driven by the audit in [#744](https://github.com/adcontextprotocol/adcp-client/issues/744).

**What the audit found.** The dispatcher releases the idempotency claim on every error path — envelope returns, envelope throws, and uncaught exceptions. That's already documented for the "transient failures don't lock into the cache" case, but the handler-author implication wasn't spelled out: a handler that mutates state before erroring will double-write on retry. The surface for this bug widened with [#743](https://github.com/adcontextprotocol/adcp-client/pull/743) (auto-unwrap of thrown envelopes), which blesses `throw adcpError(...)` as a supported path.

**Why not cache terminals instead.** The AdCP `recovery: terminal` catalog is mostly state-dependent (`ACCOUNT_SUSPENDED`, `BUDGET_EXHAUSTED`, `ACCOUNT_PAYMENT_REQUIRED`, `ACCOUNT_SETUP_REQUIRED` all flip after out-of-band remediation). Caching them would lock buyers into stale errors for the full replay TTL. Only `UNSUPPORTED_FEATURE` and `ACCOUNT_NOT_FOUND` are truly immutable, and re-executing them is cheap.

**Changes.**

- `skills/build-seller-agent/SKILL.md` idempotency section now documents the mutate-last contract, with a worked `budgetApproved` example showing the broken-vs-correct ordering and a note on making partial-write paths converge via natural-key upsert.
- `skills/build-creative-agent/SKILL.md` swaps the now-stale "throw surfaces as `SERVICE_UNAVAILABLE`" rationale (invalidated by #743) for the still-true claim-release rationale.

No runtime behavior changes; docs only. No changes to `compliance/cache/` — storyboards there are machine-synced from the upstream spec repo, so a conformance assertion that locks in error-claim-release semantics is a follow-up for `adcontextprotocol/adcp`.
