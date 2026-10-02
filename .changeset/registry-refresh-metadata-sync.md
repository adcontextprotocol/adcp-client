---
'@adcp/sdk': major
---

Sync generated registry types with the live AgenticAdvertising.org OpenAPI. Refresh availability no longer exposes the former human-refresh 503 fence fields (`code`, `retryable`, `scope`, and related remediation metadata); the 503 response uses the registry's standard Error shape. The generated metadata also includes the latest attempt and current AdCP release examples. Registry runtime behavior is unchanged.
