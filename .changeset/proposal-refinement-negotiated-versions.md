---
"@adcp/sdk": minor
---

Support public proposal refinement on AdCP 3.3 while preserving AdCP 3.2 and wire-only envelope overrides. Treat the requested version as a ceiling, accept supported lower served contracts, and validate nested proposals/change terms with the selected served bundle. Reject upward, malformed or unsupported echoes and missing selected schemas while retaining digest, lineage, hold and atomic-finalize checks.

The public request version type now includes explicit 3.3 release pins. Code reading it into an Adcp32Version variable must narrow the returned value first; Adcp32Version itself is retained unchanged.

Server typed error responses now use the active external schema root, preserving errors[] details and required discriminators for AdCP candidate bundles. Scoped and re-registered roots have isolated, loader-epoch-cached error-arm inventories, including raw schema roots, without stale misses or changes to the installed 3.2 inventory. Explicit discovery served-version evidence cross-checks compatible task ceilings, preventing a contradictory lower echo from selecting an older schema while allowing explicitly lowered request ceilings and omitted discovery echoes. Strict response validation selects the same served contract before financial verification, retaining explicit discovery evidence across durable continuation.
