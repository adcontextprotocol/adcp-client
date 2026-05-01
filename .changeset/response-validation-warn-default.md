---
'@adcp/sdk': patch
---

Response validation now defaults to `'warn'` everywhere instead of `'strict'` in non-production environments, matching the already-established request-side semantics.

Previously, schema drift in a seller's response would hard-fail the task (`result.success === false`, `result.data` missing) whenever `NODE_ENV !== 'production'`. This broke every buyer calling a v2.5 seller from a local dev or CI environment, because v2.5 sellers routinely emit responses that don't satisfy 100% of the current schema constraints (e.g. `pricing_options` empty, envelope fields sent as `null`). The asymmetry meant request drift was tolerated but response drift was not — the worse failure mode, since the buyer can't control what a seller sends back.

**After this change:** schema drift in a response goes to `result.debug_logs` as a warning; `result.data` contains the wire response unchanged. The task succeeds and the caller can decide what to do with the data.

**To opt into strict mode** (hard-fail on any schema drift), pass `validation: { responses: 'strict' }` when constructing the client. The conformance storyboard runner retains strict mode explicitly so spec deviations surface as test failures.

**Independent axes:** request and response validation are still independently configurable via `validation.requests` / `validation.responses`.
