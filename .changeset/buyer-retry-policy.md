---
'@adcp/sdk': minor
---

Ship `BuyerRetryPolicy` + `decideRetry` — operator-grade per-code retry semantics for buyer agents. Closes #1152.

The 6.3.0 recovery-classification fix corrected 12 typed-error classes from `terminal` → `correctable` per the AdCP spec. That's spec-correct, but it surfaced a real adoption gap: a naive buyer agent that just reads `error.recovery === 'correctable'` and retries-with-tweaks will spin on `POLICY_VIOLATION` (looks like governance evasion), hammer SSO endpoints on `AUTH_REQUIRED` (revoked vs missing creds), and re-call with the same `idempotency_key` after correcting the payload (which makes the seller's replay window dedupe ignore the new request).

`decideRetry(error, ctx?)` translates an `AdcpStructuredError` into a `RetryDecision` discriminated by `action`:

- **`retry`** — server-side transients (`RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `CONFLICT`). Caller replays with the SAME `idempotency_key` after `delayMs` (honors `error.retry_after` when present, else exponential backoff).
- **`mutate-and-retry`** — buyer-fixable (`*_NOT_FOUND` re-discover, `BUDGET_TOO_LOW` adjust, `TERMS_REJECTED` re-quote, `UNSUPPORTED_FEATURE` drop the field). Caller applies the correction then mints a FRESH `idempotency_key`.
- **`escalate`** — surface to a human. Includes the four spec-`correctable`-but-operator-human-escalate codes (`POLICY_VIOLATION`, `COMPLIANCE_UNSATISFIED`, `GOVERNANCE_DENIED`, `AUTH_REQUIRED`), out-of-band transients (`GOVERNANCE_UNAVAILABLE`, `CAMPAIGN_SUSPENDED`), terminal codes, attempt-cap exhaustion, and unknown vendor codes.

```ts
import { decideRetry } from '@adcp/sdk';

const decision = decideRetry(error, { attempt });

if (decision.action === 'retry') {
  await sleep(decision.delayMs);
  return callAgent({ idempotency_key: previousKey, ... }); // SAME key
}
if (decision.action === 'mutate-and-retry') {
  // Apply seller correction (decision.field, decision.suggestion)
  // and mint a fresh idempotency_key.
  return callAgent({ idempotency_key: crypto.randomUUID(), ...corrected });
}
throw new EscalationRequired(decision.reason, decision.message);
```

For per-code overrides, instantiate `BuyerRetryPolicy` directly:

```ts
const policy = new BuyerRetryPolicy({
  overrides: {
    POLICY_VIOLATION: () => ({ action: 'mutate-and-retry', ... }), // verticals where auto-tweak IS appropriate
  },
  unknownCode: 'mutate', // non-standard codes mutate-and-retry instead of escalating (default: escalate)
});
```

Default policy diverges from the spec's `recovery` field for the codes called out in #1153 — operator-grade defaults, not just a 3-class enum reflection.

**Safety guards baked into the defaults:**

- **`IDEMPOTENCY_EXPIRED` → escalate (`idempotency_check_required`)**, NOT auto-retry. The spec explicitly warns: if the prior call may have succeeded, the buyer MUST do a natural-key check before minting a new key. Otherwise this is exactly how double-creation happens. This is a financial-liability default — adopters with a registered natural-key resolver can override per-code.
- **Exponential backoff capped at 3600s.** Without it, attempt 10 with a 1s base would sleep ~17 minutes (longer than most agent task budgets); attempt 30 → ~16 days. The cap mirrors the spec's `retry_after` range.
- **Mutate-and-retry includes a 125–250ms jitter** (50–100% of a 250ms base). Without it, fleet operators running thousands of campaigns all hit the seller in lockstep after a correlated storm (e.g., `PROPOSAL_EXPIRED` across the fleet at midnight UTC). The jitter de-correlates without changing semantics.
- **Compile-time coverage** — `DEFAULT_CODE_POLICY: Record<ErrorCode, CodePolicy>` (not `Partial`), so adding a code to the spec's `ErrorCodeValues` without a policy entry fails typecheck. The runtime drift test is belt-and-suspenders.
- **`overrides` accepts both `Partial<Record<ErrorCode, ...>>` (typo-safe for standard codes) and `Record<string, ...>` (for vendor codes)** — the union catches misspellings on standard codes at compile time without locking out vendor extensions.

`attemptCap` raised to 3 for the `*_NOT_FOUND` redirect family and `TERMS_REJECTED` / `REQUOTE_REQUIRED` requote family — most buyers cache one stale ID and need one re-discovery, but ramped-pacing scenarios can cycle 2–3 times as the catalog rotates.

`ACCOUNT_AMBIGUOUS` is `escalate (auth)` — spec says "pass explicit account_id" but the agent typically doesn't have the right ID cached without going back to `list_accounts`; escalating with the seller's hint is more honest than burning a guaranteed-wrong replay.

Adopters using the existing `isRetryable()` / `getRetryDelay()` helpers in `@adcp/sdk` continue to work — `decideRetry` is additive.
