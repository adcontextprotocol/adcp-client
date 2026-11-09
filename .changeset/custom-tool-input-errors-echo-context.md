---
'@adcp/sdk': minor
---

Tools with a zod input schema now validate it at the AdCP layer, so a rejected call returns an AdCP error that echoes `context` (#3666). This covers:

- `customTools` on `createAdcpServer`, and so `tasks_get` on `createAdcpServerFromPlatform`
- `comply_test_controller` from `registerTestController`, `createComplyController().register()` and `createAdcpServerFromPlatform({ complyTest })`

Before, the MCP SDK checked the arguments before any AdCP code ran and answered a failure with a bare `-32602` text result. That result had no `structuredContent`, no `adcp_error` and no `context`, which breaks the context-sessions rule that failures echo `context`. See [Custom tool input validation](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/migration-16-to-17.md#custom-tool-input-validation) in the 16 → 17 migration guide.

- **Error shape (breaking for buyers that matched the old text).** A call that fails the declared schema now gets `adcp_error` with:
  - code `INVALID_REQUEST`
  - `field`, naming the first failing path; a missing property is reported at its own path (`field: 'query'`)
  - field-level `issues`, also at `details.issues`
  - the caller's `context`, `status: 'failed'` and the served `adcp_version`

  This is the envelope framework tools return. **Buyers that matched the `-32602` text, the `Input validation error:` prefix, or `isError` without `structuredContent` must read `adcp_error` instead.** Framework tools still emit `VALIDATION_ERROR` for request-schema failures; #3674 tracks converging them on `INVALID_REQUEST`.

- **Handlers get the parsed value on every path (breaking for handlers that read undeclared keys outside MCP).** On MCP a valid call reaches the handler with the same parsed value as before: zod coercion, defaults and transforms applied, undeclared keys stripped. `AdcpServer.invoke()`, `dispatchTestRequest()` and A2A used to skip the schema and hand custom-tool handlers the caller's raw arguments. **They now validate too, and pass the same parsed, stripped value.** On those paths an invalid call no longer reaches the handler, and the handler no longer sees keys its schema does not declare. A handler that reads such keys must declare them, or use a loose object (`z.looseObject({...})`, or `z.object({...}).passthrough()` on zod 3).
- **Discovery.** MCP `tools/list` still advertises the declared schema, on the legacy SDK and on the 2026-07-28 adapter. Internally the SDK now registers a passthrough schema for these tools.
- **Release selection.** A custom tool whose schema does not declare `adcp_version` now honors it on MCP, as A2A already did. Release selection reads the caller's arguments before the declared schema strips undeclared keys, so an unsupported version gets `VERSION_UNSUPPORTED` before the handler runs.
