---
'@adcp/sdk': patch
---

Flush in-memory task registries from compliance.reset() so repeated storyboard runs can reuse hardcoded task IDs.
