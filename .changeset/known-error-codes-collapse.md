---
'@adcp/sdk': patch
---

Collapse the second hand-rolled error-code source.

`KNOWN_ERROR_CODES` in `src/lib/server/decisioning/async-outcome.ts` was a parallel hand-maintained array of error codes — same shape of bug as the `StandardErrorCode` drift fixed in 6.2.0, just one file over. The author had even left a `TODO(6.0): generate this from schemas/cache/<version>/enums/error-code.json` flag for future-self.

Now derived from the generated `ErrorCodeValues` (and `ErrorCode` aliases `StandardErrorCode`), so:

- New codes added to the spec light up everywhere downstream — typo warn, autocomplete, the `ErrorCode` union — without a hand-edit.
- The two error-code "sources of truth" are now one source.
- Warn message reports the count from the array rather than a stale hardcoded "45".

No behavior change at the type or runtime layer; the array contains the same 45 codes it did before, just sourced from codegen now.
