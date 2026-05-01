---
"@adcp/sdk": patch
---

Fix warn-mode validation crashing when schema bundle is not populated

Commit `df91b27` changed the client-side validation default from `off` to `warn`, but the `warn` path in `validateOutgoingRequest` and `validateIncomingResponse` did not handle the `SchemaBundleNotFoundError` that `resolveSchemaRoot` throws when `npm run sync-schemas` has not been run. The unhandled error propagated through `SingleAgentClient.createMediaBuy` (and every other typed method), causing storyboard A2A tests and context-retention tests to fail on every CI run.

Three fixes:

1. `schema-loader.ts`: Introduce `SchemaBundleNotFoundError` (typed, `code: 'SCHEMA_BUNDLE_NOT_FOUND'`) so callers can distinguish "schemas not populated" (infrastructure gap, safe to skip in `warn` mode) from `ConfigurationError` (bad version string, always re-throw).

2. `client-hooks.ts`: Catch `SchemaBundleNotFoundError` in `validateOutgoingRequest` and `validateIncomingResponse` when mode is `warn` — log a `type: 'warning'` debug entry and skip validation rather than throwing. In `strict` mode, re-throw so hard-stop callers still get the error they opted into.

3. `validations.ts`: Wrap the `validateResponse` call in `computeStrictVerdict` in a try-catch that returns `undefined` on `SchemaBundleNotFoundError` — the function's contract is already "return undefined when no AJV schema is available."

Test fix: the regressed-adapter fixture in `storyboard-a2a-async-submitted-yaml.test.js` used `supported_protocols: ['media-buy']` (hyphen) instead of `['media_buy']` (underscore), causing the capability feature gate to skip the `create_media_buy` step before the wire-shape assertion could run.
