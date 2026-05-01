---
"@adcp/sdk": minor
---

Add `BuyerRetryPolicy` helper with per-code recovery defaults.

Translates `AdcpErrorInfo` into a concrete `RetryDecision` (`retry` / `mutate-and-retry` / `escalate`) using operator-grade per-code defaults that go beyond the spec's three-class `recovery` enum. Codes like `POLICY_VIOLATION`, `COMPLIANCE_UNSATISFIED`, `GOVERNANCE_DENIED`, `CREATIVE_REJECTED`, `AUTH_REQUIRED`, and `PERMISSION_DENIED` default to `escalate` to prevent automated mutation from looking like policy evasion. Supports constructor-level per-code overrides for vertical-specific behavior.

Also adds SKILL.md callout documenting the four human-escalate codes and a worked recovery loop example, and adds a corresponding note in BUILD-AN-AGENT.md for seller-side authors. Closes #1152.
