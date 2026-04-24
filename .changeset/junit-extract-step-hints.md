---
"@adcp/client": patch
---

Extracts the JUnit XML formatter out of `bin/adcp.js` into `src/lib/testing/storyboard/junit.ts` so the formatter is testable as a pure function. Closes three deltas salvaged from closed PR #894:

- **`adcp storyboard step` printer**: now renders `💡 Hint: …` below the `Error:` line (was dropped silently before). Matches the step printer's column-zero style.
- **`<failure message=…>` attribute fallback**: when `step.error` is absent (e.g. the #883-widened hint gate fires on a validation-only failure), the first hint's message is used so CI dashboards that only read the attribute still surface the diagnosis.
- **`formatStoryboardResultsAsJUnit` exported as `@internal`** on `@adcp/client/testing` — the CLI imports it from there; consumers that want to emit JUnit themselves can, but the module isn't a supported public API.

Also drops the unused `formatHintsForFailureBody` helper from `bin/adcp-step-hints.js` now that the JUnit formatter owns its own hint rendering, and parameterizes `printStepHints` with an `indent` argument so both printers (phase-nested 3-space and column-zero) can share it.
