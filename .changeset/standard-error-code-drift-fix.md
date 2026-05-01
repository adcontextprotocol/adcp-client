---
'@adcp/sdk': patch
---

Fix `StandardErrorCode` drift against the AdCP error-code enum.

`StandardErrorCode` (in `src/lib/types/error-codes.ts`) was hand-maintained and had drifted to 28 codes against the spec's 45. Codegen produces the full set in `enums.generated.ts` `ErrorCodeValues`, but nothing tied that to the hand-rolled union. Each PR added the codes it personally needed and walked away — when AdCP 3.0 GA added 17 new codes (`TERMS_REJECTED`, `GOVERNANCE_DENIED`, `PERMISSION_DENIED`, `CREATIVE_DEADLINE_EXCEEDED`, `IO_REQUIRED`, `REQUOTE_REQUIRED`, `CAMPAIGN_SUSPENDED`, `GOVERNANCE_UNAVAILABLE`, `SESSION_NOT_FOUND`, `SESSION_TERMINATED`, `PLAN_NOT_FOUND`, `PROPOSAL_NOT_COMMITTED`, `CREATIVE_NOT_FOUND`, `SIGNAL_NOT_FOUND`, `REFERENCE_NOT_FOUND`, `PRODUCT_EXPIRED`, `VERSION_UNSUPPORTED`), they never landed in the SDK's strongly-typed handle.

Three layers of defense, applied in order:

1. **Type derivation.** `StandardErrorCode` is now `(typeof ErrorCodeValues)[number]` — physically tied to the generated enum. The hand-rolled string-literal union is gone.
2. **Compile-time completeness.** `STANDARD_ERROR_CODES satisfies Record<StandardErrorCode, ErrorCodeInfo>` — adding a code to the spec without filling in a description and recovery row will fail typecheck.
3. **Runtime drift guard.** A new test (`test/lib/standard-error-codes-drift.test.js`) asserts `Object.keys(STANDARD_ERROR_CODES).sort()` deep-equals `[...ErrorCodeValues].sort()` and that every entry has a valid `transient | correctable | terminal` classification. Belt-and-suspenders for the type derivation: if someone ever breaks the derivation by re-hand-typing the union, the test still fires.

**Recovery-classification bugs surfaced by the audit and corrected to match the spec:**

| Code | Was | Now (spec-correct) | Buyer impact |
| --- | --- | --- | --- |
| `CONFLICT` | `correctable` | `transient` | Concurrent-modification retry was being treated as a buyer-correctable error; should retry with current state instead. |
| `PRODUCT_UNAVAILABLE` | `transient` | `correctable` | Sold-out / no-longer-available was being retried in a loop; should pick a different product instead. |
| `UNSUPPORTED_FEATURE` | `terminal` | `correctable` | Unsupported field was treated as fatal; should check `get_adcp_capabilities` and remove the unsupported field instead. |

Adopters using `getErrorRecovery()` to drive retry logic will now branch correctly per the spec. If you were depending on the buggy classifications you'll need to update — the new behavior is what the spec required all along.

Bumps `STANDARD_ERROR_CODES` from 28 → 45 entries with descriptions condensed from the spec's `enumDescriptions` block. Agents using `getErrorRecovery(code)` now classify the 17 previously-unknown codes correctly instead of returning `undefined`.

No breaking change: existing call sites that passed standard codes to `adcpError(...)` continue to compile (the union widened, didn't narrow). Call sites that passed non-standard codes still go through the `(string & {})` overload.
