---
'@adcp/sdk': patch
---

Package the signed AdCP 3.2.8 bundle as the maintained 3.2 line, replacing 3.2.7, to match SDK 16.6. A pair that negotiates 3.2 now validates against 3.2.8, which carries the DR-0036 corrections: the reopened 3.2 proposal-flow roots, the envelope composition on every task payload, and the `adcp_version` echo. `3.2.8` is advertised alongside the earlier 3.2 patches. Explicit `--compliance-version 3.2.7` pins advance to `3.2.8`.
