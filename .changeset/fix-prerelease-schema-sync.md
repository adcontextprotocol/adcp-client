---
'@adcp/sdk': patch
---

Fix schema-sync version updates for prerelease SDK builds so beta and RC
versions advance their numeric prerelease identifier instead of producing an
invalid `NaN` patch version.
