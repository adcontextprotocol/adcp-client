---
'@adcp/sdk': minor
---

storyboard runner: resolve a storyboard's declared `prerequisites.test_kit` from the compliance cache into `options.test_kit` (caller-supplied kits win), and hard-fail steps whose `auth.from_test_kit` resolves no credential instead of silently sending an unauthenticated probe (adcontextprotocol/adcp#6735). Previously the declaration was decorative: runs without an explicit kit degraded credential-keyed steps (comply_controller_mode_gate) to no-auth probes, grading conformant sellers FAIL. Declared kit paths are containment-checked against the cache root; a declared kit missing from the cache is tolerated at load time (only steps that actually need the credential fail, with an explicit configuration error).
