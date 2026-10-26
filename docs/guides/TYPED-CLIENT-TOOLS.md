# Typed client tools

`SingleAgentClient` and `AgentClient` expose a camelCase method for every tool
in the bundled AdCP manifest. Each method uses the normal request validation,
idempotency-key generation, and per-client version negotiation. `executeTask`
also has typed request and response mappings for every tool.

```ts
const result = await client.getTaskStatus({ task_id: sellerTaskId, include_result: true });
if (result.success) console.log(result.data.status, result.data.result);

const tasks = await client.listTasks({}); // Queries the seller's list_tasks tool.
```

`getTaskStatus({ task_id })` returns the protocol response inside `TaskResult`.
The observed task's `status` and `error` remain data: querying a failed or working
task completes the query without resubmitting or following that task.

For compatibility, `getTaskStatus(taskId)` still returns mapped `TaskInfo`, and
`listTasks()` with no arguments still lists locally tracked tasks. Use
`trackTask()` or a submitted result's `waitForCompletion()` to observe completion.
The object overload calls `get_task_status` directly and requires a seller that
supports that tool. Use the string overload or task tracking for negotiated
compatibility with older sellers.
The typed response preserves the seller's `task_id`; callers should compare it
with the requested ID. The string overload and completion tracking enforce that
identity check automatically. Discovery and authorization failures are surfaced
rather than treated as evidence that only the legacy tool is supported.

SDK polling chooses `get_task_status` when advertised by the seller, falling back
to `tasks_get` for MCP or `tasks/get` for A2A otherwise.

The supported tools `listCreativeFormats`, `buildCreative`, `listTransformers`,
`getContentStandards`, `listContentStandards`, `calibrateContent`, and
`validateContentDelivery` have ordinary typed methods. Their existing `*Legacy`
aliases remain available. These tool methods return their protocol wire shapes;
the SDK's canonical creative discovery and delivery helpers remain available too.
On the SDK 16 line these are the AdCP 3.2 wire shapes, including any legacy
`format_id` fields the protocol still supports. Generic `preview_creative`
execution uses the canonical preview helper; use `previewCreativeLegacy` for
raw named-format requests.

Direct `SingleAgentClient.syncPlans` and `getPlanAuditLogs` calls use the
configured governance agent when present. Without one, the client requires its
own agent to advertise the governance tool before sending the request.

`complyTestController` is typed for conformance testing against a seller that
advertises it. Its availability does not imply that a production seller enables
test controls.
