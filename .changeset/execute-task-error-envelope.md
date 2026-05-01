---
'@adcp/sdk': patch
---

`executeTask` now returns a structured `TaskResult` instead of throwing for pre-flight errors (fixes #1148).

**Symptom:** `agent.executeTask('list_authorized_properties', {})` against a v2.5 MCP seller threw `TypeError: Cannot read properties of undefined (reading 'status')` instead of returning `{ success: false, status: 'failed', error: '...' }`.

**Root cause:** `SingleAgentClient.executeTask` (the public generic path used for tasks without a named wrapper) had no top-level try/catch. Pre-flight steps — feature validation, endpoint discovery, schema validation, version detection, and request adaptation — could escape as raw exceptions. The internal `TaskExecutor.executeTask` already wraps network-layer errors; `SingleAgentClient` had no matching safety net for the steps it runs before delegating to the executor.

`list_authorized_properties` is the common trigger because it has no named helper method on `AgentClient` (deprecated in favour of `get_adcp_capabilities`) so all callers go through `executeTask`. On a v2.5 MCP seller, the response shape is unexpected and a TypeError escapes during pre-flight processing.

**Fix:** Wrap the full `SingleAgentClient.executeTask` body in a try/catch. `AuthenticationRequiredError` and `TaskTimeoutError` are rethrown — they are established throws that callers handle explicitly (e.g. to trigger OAuth flows). All other pre-flight errors are converted to `{ success: false, status: 'failed', error: message }` envelopes, matching the declared return type `Promise<TaskResult<T>>`.

Callers that followed the TypeScript return type and checked `result.success` / `result.status` are unaffected. Callers that relied on `executeTask` throwing for pre-flight errors (other than auth/timeout) will now receive a structured failure envelope instead — which is the correct behaviour per the declared type.
