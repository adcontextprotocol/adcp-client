---
'@adcp/sdk': patch
---

Export named server `*Payload` and `*HandlerResult` aliases for decisioning handlers, and keep those payload types aligned with runtime response projection by stripping write-only webhook credentials and billing bank fields. The reusable `*Payload` aliases are also available from `@adcp/sdk` and `@adcp/sdk/types` for adopter adapter layers that do not import the server framework.

Adopters that annotated server helper layers with generated wire `*Response` / `*Success` types should switch those annotations to the exported aliases from `@adcp/sdk/server`, or use `ServerPayload<T>` directly for less common generated response shapes.
