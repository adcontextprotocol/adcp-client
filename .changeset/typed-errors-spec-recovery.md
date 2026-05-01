---
'@adcp/sdk': minor
---

**Behavior change for `getErrorRecovery()` callers and adopters using typed-error classes.** Closes #1136.

Recovery classifications across the typed-error class hierarchy in `src/lib/server/decisioning/errors-typed.ts` were hardcoded and had drifted from the AdCP 3.0 spec. The 6.2.0 release fixed three classifications in `STANDARD_ERROR_CODES` (`CONFLICT`, `PRODUCT_UNAVAILABLE`, `UNSUPPORTED_FEATURE`); the remaining ~12 typed-error classes still hardcoded wrong recovery values. This release:

1. **Makes `AdcpError.recovery` optional.** The constructor now defaults `recovery` from `getErrorRecovery(code)` when omitted (and to `'correctable'` for non-standard `(string & {})` codes). Adopters who want to override per-instance still pass `recovery` explicitly.
2. **Drops the hardcoded `recovery` field from every typed-error class.** All ~20 classes inherit recovery from the spec via the new default. Same for the `validationError` and `upstreamError` factory helpers.
3. **Adds a drift guard test.** `every typed-error class recovery matches getErrorRecovery(code)` — if anyone re-introduces a hardcoded `recovery` that diverges from the spec, this fires.

**Recovery values that change as a result** (these were the spec-conformant values all along; the typed classes were wrong):

| Class / code | Was | Now (spec-correct) |
| --- | --- | --- |
| `PackageNotFoundError` (`PACKAGE_NOT_FOUND`) | `terminal` | `correctable` |
| `MediaBuyNotFoundError` (`MEDIA_BUY_NOT_FOUND`) | `terminal` | `correctable` |
| `ProductNotFoundError` (`PRODUCT_NOT_FOUND`) | `terminal` | `correctable` |
| `CreativeNotFoundError` (`CREATIVE_NOT_FOUND`) | `terminal` | `correctable` |
| `CreativeRejectedError` (`CREATIVE_REJECTED`) | `terminal` | `correctable` |
| `IdempotencyConflictError` (`IDEMPOTENCY_CONFLICT`) | `terminal` | `correctable` |
| `InvalidStateError` (`INVALID_STATE`) | `terminal` | `correctable` |
| `AuthRequiredError` (`AUTH_REQUIRED`) | `terminal` | `correctable` |
| `PermissionDeniedError` (`PERMISSION_DENIED`) | `terminal` | `correctable` |
| `ComplianceUnsatisfiedError` (`COMPLIANCE_UNSATISFIED`) | `terminal` | `correctable` |
| `GovernanceDeniedError` (`GOVERNANCE_DENIED`) | `terminal` | `correctable` |
| `PolicyViolationError` (`POLICY_VIOLATION`) | `terminal` | `correctable` |

`BudgetTooLowError` (`correctable`), `BudgetExhaustedError` (`terminal`), `RateLimitedError` (`transient`), `ServiceUnavailableError` (`transient`), `ProductUnavailableError` and `UnsupportedFeatureError` (both `correctable` after 6.2.0), `InvalidRequestError` and `BackwardsTimeRangeError` (both `correctable`) were already spec-correct and continue to behave the same.

**Architectural payoff:** there's now exactly one source of truth for recovery semantics — `STANDARD_ERROR_CODES`, which derives from the generated `ErrorCodeValues`. Adding a code to the spec lights up everywhere; changing a recovery value lights up everywhere. The drift mechanism that produced 6.2.0's three corrections (and this release's twelve) is closed.

**No source-compatibility break:** existing call sites that pass `recovery` explicitly continue to compile and behave the same. Adopters using `getErrorRecovery()` to drive retry logic will see corrected branch behavior — buyers should retry / pick alternative products / check capabilities for these correctable errors instead of giving up.
