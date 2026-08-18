---
'@adcp/sdk': patch
---

Make external schema roots authoritative for storyboard request and response validation, including `latest` schema IDs pinned by a matching schema index, so pre-publish protocol builds are not rejected by the SDK's generated validator snapshot.
