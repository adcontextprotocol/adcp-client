---
'@adcp/client': patch
---

chore(server): migrate McpServer.tool() → registerTool() repo-wide (#705)

Replaces every use of the MCP SDK's deprecated `McpServer.tool(...)`
overload with the supported `registerTool(name, config, handler)` form.
Behavior is unchanged; `tools/list` output is identical aside from a
cleaner path to the same metadata.

**What moved**

- `src/lib/server/create-adcp-server.ts` — the AdcpToolMap registration
  loop and `get_adcp_capabilities` now use `registerTool`, with
  `annotations` declared at register time instead of via a post-hoc
  `.update()` call.
- `src/lib/server/test-controller.ts`, `src/lib/testing/comply-controller.ts`
  — `comply_test_controller` registration.
- `src/lib/testing/stubs/governance-agent-stub.ts` — all five tools
  (`get_adcp_capabilities`, `sync_plans`, `check_governance`,
  `report_plan_outcome`, `get_plan_audit_logs`).
- `examples/error-compliant-server.ts` — the canonical seller template.
- JSDoc, prose, and README-ish comments updated to the new form.

**`outputSchema` deliberately not wired on framework tools**

The MCP SDK's *client-side* `callTool` validates `structuredContent`
against the declared `outputSchema` whenever structuredContent is
present — regardless of `isError`
(`@modelcontextprotocol/sdk/dist/esm/client/index.js:504`). AdCP's
`adcpError()` envelope carries `structuredContent: { adcp_error: {...} }`
alongside `isError: true`, which would fail every client-side outputSchema
check (the error shape doesn't match the success schema). Until the SDK
gates that client-side check on `!isError` (the server-side validator
already does), framework-registered tools are migrated *without*
`outputSchema`. Response drift is caught by the dispatcher's AJV
validator (#727) instead, and `customTools` may opt in explicitly via
`customTools[*].outputSchema` — validated by a new regression test.

Closes #705.
