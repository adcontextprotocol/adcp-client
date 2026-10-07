---
'@adcp/sdk': patch
---

Update the pinned protocol bundle to AdCP 3.2.3, including the A2A request-signing security errata for GHSA-2pm6-6mc8-8xcm and its 33 operation-resolution vectors. Regenerate schemas, types, and release documentation against the signed maintenance bundle and register its unchanged reviewed commercial terms. Retain the supported legacy schema bundles.

The packaged 3.2 compliance corpus advances from 3.2.1 to 3.2.3; use `--compliance-version 3.2.3` for CLI grading of this release.
