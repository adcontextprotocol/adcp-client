---
'@adcp/sdk': minor
---

Tools with a zod input schema now validate it at the AdCP layer, so a rejected call returns an AdCP error that echoes `context` (#3666). This covers `customTools` on `createAdcpServer` (and so `tasks_get` on `createAdcpServerFromPlatform`) and `comply_test_controller` from `registerTestController`, `createComplyController().register()` and `createAdcpServerFromPlatform({ complyTest })`. Before, the MCP SDK checked the arguments before any AdCP code ran and answered a failure with a bare `-32602` text result: no `structuredContent`, no `adcp_error`, and no `context`, which breaks the context-sessions rule that failures echo `context`.

- **Error shape.** A call that fails the declared schema now gets `adcp_error` with code `INVALID_REQUEST`, `field` naming the first failing path, field-level `issues` (also at `details.issues`), the caller's `context`, `status: 'failed'` and the served `adcp_version`, the same envelope framework tools return. A missing property is reported at its own path (`field: 'query'`). **Buyers that matched the `-32602` text, `isError` without `structuredContent`, or the `Input validation error:` prefix must read `adcp_error` instead.**
- **Discovery.** MCP `tools/list` still advertises the declared schema, on the legacy SDK and on the 2026-07-28 adapter. The SDK now registers a passthrough schema for these tools.
- **Handlers.** A valid call reaches the handler with the parsed value, so zod coercion, defaults, transforms and stripping of undeclared keys apply as before. `AdcpServer.invoke()`, `dispatchTestRequest()` and A2A calls bypassed the MCP SDK and handed custom-tool handlers the raw arguments; they now get the same validation and parsed value as MCP calls.
- **Release selection.** A custom tool whose schema does not declare `adcp_version` now honors it on MCP, as A2A already did, because release selection reads the caller's arguments before the declared schema strips undeclared keys.
