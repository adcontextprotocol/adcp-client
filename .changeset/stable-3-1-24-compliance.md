---
'@adcp/sdk': patch
---

Bundle AdCP 3.1.24 compliance and schema data on the maintained 13.x line, validate 3.1 capability extensions against the selected compliance schema during major-only discovery, and preserve read-only `get_products` behavior when its `idempotency_key` is optional. Keyed `get_products` calls now receive replay protection, and the client generates a key for proposal finalization. The stale 3.1.20 compliance cache is no longer bundled; callers pinned to that exact patch should provide matching `--compliance-dir` and `--schema-root` paths.
