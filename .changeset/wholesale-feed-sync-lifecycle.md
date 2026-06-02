---
'@adcp/sdk': patch
---

Harden WholesaleFeedSync lifecycle recovery by cancelling stale in-flight bootstraps after stop, committing feed indexes and version tokens atomically after successful bootstrap, and bounding version-mismatch repair retries.
