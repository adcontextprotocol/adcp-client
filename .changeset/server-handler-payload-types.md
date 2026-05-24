---
'@adcp/sdk': patch
---

Type server/platform handler returns as domain payloads rather than requiring protocol task-envelope fields from generated wire response types. The SDK continues to stamp envelope fields such as `status: "completed"` at dispatch time.

Adopters that annotated server helper layers with generated wire `*Response` / `*Success` types should switch those annotations to the exported `*Payload` / `*HandlerResult` aliases from `@adcp/sdk/server`, or use `ServerPayload<T>` directly for less common generated response shapes.
