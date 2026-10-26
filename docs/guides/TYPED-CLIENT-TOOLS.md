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
SDK polling chooses `get_task_status` when advertised by the seller, falling back
to `tasks_get` for MCP or `tasks/get` for A2A otherwise.

The supported tools `listCreativeFormats`, `buildCreative`, `listTransformers`,
`getContentStandards`, `listContentStandards`, `calibrateContent`, and
`validateContentDelivery` have ordinary typed methods. Their existing `*Legacy`
aliases remain available. These tool methods return their protocol wire shapes;
the SDK's canonical creative discovery and delivery helpers remain available too.

`complyTestController` is typed for conformance testing against a seller that
advertises it. Its availability does not imply that a production seller enables
test controls.
