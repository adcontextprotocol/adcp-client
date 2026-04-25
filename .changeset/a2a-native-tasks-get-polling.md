---
"@adcp/client": patch
---

fix(protocols): A2A polling now uses native `tasks/get` JSON-RPC instead of `callTool/message/send`

`TaskExecutor.getTaskStatus` was routing A2A task polling through `ProtocolClient.callTool('tasks/get', …)`, which dispatched `message/send { skill: 'tasks/get' }`. Conformant A2A sellers (running `createA2AAdapter`) reject this because `tasks/get` is a native A2A JSON-RPC method, not an AdCP tool name — causing the polling loop to surface a false task-failed result.

**Fix:** Added `getA2ATaskStatus` to `src/lib/protocols/a2a.ts` (parallel to `getMCPTaskStatus`) that calls `client.getTask({ id })` on the `@a2a-js/sdk` `A2AClient`. `TaskExecutor.getTaskStatus` now dispatches to this for `protocol: 'a2a'` agents. `setupSubmittedTask` extracts the server-assigned A2A `Task.id` from the initial `message/send` response and threads it into the `track`/`waitForCompletion` closures — using it instead of the client-minted correlation UUID that `tasks/get` would not recognize.

**Status mapping:** `Task.status.state` is always `'completed'` for submitted AdCP arms (the transport call finished, not the AdCP work). The real AdCP lifecycle status is now read from `artifact.parts[last-data-part].data.status`, with A2A terminal states (`failed`/`rejected`) as the fallback when no artifact payload is present.
