---
'@adcp/client': minor
---

`createAdcpServer`'s `exposeErrorDetails` now defaults to `true` outside `NODE_ENV=production`. Handler throws emit the underlying cause message and handler name in `adcp_error.details` + the human-readable text, so agent authors see `SERVICE_UNAVAILABLE: Tool acquire_rights handler threw: Cannot find module '@adcp/client/foo'` instead of the opaque `encountered an internal error` we used to ship.

- Production behavior is unchanged (errors stay redacted for live agents).
- Explicit `exposeErrorDetails: false` still wins — production deployments that want the redaction without relying on `NODE_ENV` should keep setting it.
- `logger.error('Handler failed', ...)` now includes the full stack (`err.stack`) so server logs point at the exact line that blew up, not just the message.

Matrix-harness debuggability was the driver: every `SERVICE_UNAVAILABLE` in matrix v5–v7 was an opaque black box that required re-running with `--keep-workspaces` and inspecting Claude-generated code to figure out why a handler threw. With this default, the matrix log shows the fault line on the first run.
