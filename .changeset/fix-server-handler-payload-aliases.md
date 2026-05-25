---
'@adcp/sdk': patch
---

Export named server `*Payload` and `*HandlerResult` aliases for decisioning handlers, and keep those payload types aligned with runtime response projection by stripping write-only webhook credentials and billing bank fields.

Adopters that annotated server helper layers with generated wire `*Response` / `*Success` types should switch those annotations to the exported aliases from `@adcp/sdk/server`, or use `ServerPayload<T>` directly for less common generated response shapes.
