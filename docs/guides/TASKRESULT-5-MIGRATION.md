# TaskResult 5.0 Migration Guide

`@adcp/client` 5.0 turned `TaskResult` into a discriminated union. Failed
tasks now use `status: 'failed'` instead of `status: 'completed'`, and MCP
`isError` responses preserve structured data (`adcp_error`, `context`,
`ext`) instead of throwing.

This page covers the four migration patterns every consumer hits.

## The new shape

```ts
type TaskResult<T> =
  | { success: true;  status: 'completed';                                             data: T }
  | { success: true;  status: 'working' | 'submitted' | 'input-required' | 'deferred'; data?: T }
  | { success: false; status: 'failed' | 'governance-denied' | 'governance-escalated'; data?: T;
      error: string;
      adcpError?: { code: string; recovery?: string; retryAfterMs?: number; /* ... */ };
      correlationId?: string };
```

Rule of thumb: **branch on `success` first, then narrow on `status`.**

## Pattern 1 — Success check

**Before (4.x):**

```ts
try {
  const result = await client.getProducts({ brief: 'shoes' });
  console.log(result.data.products);
} catch (err) {
  console.error('failed:', err);
}
```

**After (5.x):**

```ts
const result = await client.getProducts({ brief: 'shoes' });
if (!result.success) {
  console.error('failed:', result.error);
  return;
}
// `result.data` is `T` here — narrowed by the discriminated union
console.log(result.data.products);
```

Failures no longer throw. If you want the old throw-on-error behavior,
wrap once at your call site:

```ts
function orThrow<T>(r: TaskResult<T>): T {
  if (!r.success) throw new Error(r.error);
  if (r.status !== 'completed') throw new Error(`task not complete: ${r.status}`);
  return r.data;
}
```

## Pattern 2 — Error extraction

**Before:**

```ts
catch (err) {
  if (err.code === 'INSUFFICIENT_BUDGET') { ... }
}
```

**After:**

```ts
if (!result.success && result.adcpError?.code === 'INSUFFICIENT_BUDGET') {
  // adcp_error, suggestion, recovery hints are all on result.adcpError
}
```

Full structured error lives on `result.adcpError`. The raw response payload
(including `context` and `ext`) is on `result.data` even for failures.
`result.error` is a human-readable string — but only on the failure arm.
After `if (!result.success)` the union narrows so `result.error` is
guaranteed `string`; on the success arms it's `undefined`. Always guard on
`success` before reading `error`.

### Retry helpers

```ts
import { isRetryable, getRetryDelay } from '@adcp/client';

if (!result.success && isRetryable(result)) {
  await sleep(getRetryDelay(result, /* default */ 5000));
  // retry…
}
```

`isRetryable` narrows to failures with `recovery: 'transient'`.
`getRetryDelay` returns the agent-provided `retryAfterMs` or a default.

## Pattern 3 — Status narrowing

**Before:** `status` was always `'completed'` (or a throw). You only had
one branch.

**After:** narrow on `status` to handle governance outcomes without
losing type information.

```ts
if (!result.success) {
  switch (result.status) {
    case 'failed':
      log.error('agent error', { code: result.adcpError?.code });
      break;
    case 'governance-denied':
      notifyApprover(result.adcpError);
      break;
    case 'governance-escalated':
      trackPending(result.correlationId);
      break;
  }
  return;
}
```

TypeScript narrows `result.adcpError` / `result.correlationId` based on
`success: false`.

## Pattern 4 — Intermediate states

Long-running tasks now return intermediate `TaskResult`s rather than
resolving only at completion.

**Before:** you only ever saw `status: 'completed'`.

**After:** handle the three non-terminal statuses explicitly.

```ts
const result = await client.createMediaBuy(params);

switch (result.status) {
  case 'completed':
    // result.data is T
    return result.data;

  case 'submitted':
    // server is processing — pick up via result.submitted
    return pollLater(result.submitted?.taskId);

  case 'input-required':
    // agent needs clarification — your InputHandler runs
    // if it doesn't, result.data has the clarification request
    return;

  case 'deferred':
    // client-side wait — result.deferred holds the continuation
    return;

  case 'failed':
  case 'governance-denied':
  case 'governance-escalated':
    // see Pattern 2
    return;
}
```

For most callers the high-level `ADCPMultiAgentClient` / `AgentClient`
methods already loop until a terminal status before returning. You'll
mostly hit intermediate states if you use lower-level `TaskExecutor` APIs
directly.

## Typescript note

The discriminated union makes exhaustiveness checks cheap:

```ts
function assertNever(x: never): never { throw new Error(String(x)); }

switch (result.status) {
  case 'completed': ...
  case 'working': ...
  case 'submitted': ...
  case 'input-required': ...
  case 'deferred': ...
  case 'failed': ...
  case 'governance-denied': ...
  case 'governance-escalated': ...
  default: assertNever(result);  // TS errors if you miss a status
}
```
