---
"@adcp/sdk": patch
---

Fix A2A storyboard regression-adapter tests failing on every PR (issue #1178).

Three runtime fixes:

1. **Runner validation gate** (`runner.ts`): The gate that runs step validations was conditioned on `taskResult || httpResult`. For A2A steps where the task threw (e.g. pre-terminal `submitted` state), neither was set even though an A2A envelope was captured. Gate now includes `a2aEnvelope` so wire-shape checks (`a2a_submitted_artifact`, `a2a_context_continuity`) fire on captured envelopes regardless of whether the AdCP task layer succeeded.

2. **Schema-load error isolation** (`validations.ts`): `computeStrictVerdict` called `validateResponse` which throws when the schema bundle is absent (CI without `sync-schemas`). The throw propagated through `runValidations`'s `.map()` and aborted the entire validator loop, so `a2a_submitted_artifact` never ran. Wrapped in try/catch; missing bundle is now treated as "no AJV signal available" (returns `undefined`), matching the existing `variant: 'skipped'` path.

3. **Request validation schema-load error isolation** (`client-hooks.ts`): `validateOutgoingRequest` in `warn` mode now catches schema-bundle-missing errors and logs a warning instead of propagating the throw. Strict mode still re-throws for misconfigured environments.

Two test-fixture fixes that were masking the regressions:

- `startRegressedA2aFixture` in both test files returned `tools: []` or `supported_protocols: ['media-buy']` (hyphen, wire format) in the `get_adcp_capabilities` response. The SDK's `resolveFeature('media_buy')` checks `protocols.includes('media_buy')` (underscore internal format), so `['media-buy']` caused `FeatureUnsupportedError` → early-exit skip before the validator gate. Fixed to use `['media_buy']` to match the SDK's internal representation, consistent with `createAdcpServer`'s default capabilities response.
- `startRegressedA2aFixture` in the continuity test returned `tools: []`, causing the runner to skip the `first_send` step entirely (no advertised tools). `priorA2aEnvelopes` was never populated, so the continuity check always passed with "first_a2a_step: skipped". Fixed to include the relevant tools.
