---
'@adcp/sdk': patch
---

Type server/platform handler returns as domain payloads rather than requiring protocol task-envelope fields from generated wire response types. The SDK continues to stamp envelope fields such as `status: "completed"` at dispatch time, and exports `ServerPayload<T>` for adopters that want explicit payload return annotations.
