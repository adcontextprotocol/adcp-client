---
"@adcp/sdk": patch
---

fix: `validateOutgoingRequest` in warn mode no longer throws when `schemas/cache/` is unpopulated

Previously, calling any AdCP tool with `validation.requests: 'warn'` (the default) would throw an unhandled `SchemaBundleNotFoundError` if the schema bundle had not been populated via `npm run sync-schemas`. The throw escaped before the warn-mode guard, causing `taskResult` to be `undefined` in the storyboard runner and silently skipping all step validations — including `a2a_context_continuity`.

The fix wraps the `validateRequest` call in a try/catch: in warn mode the error is swallowed and validation is skipped (same behaviour as `off` for missing bundles); in strict mode it re-throws so CI catches misconfigured environments. Closes #1178 (context-continuity integration test leg).
