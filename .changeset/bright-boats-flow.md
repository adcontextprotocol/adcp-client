---
"@adcp/client": minor
---

### Breaking Changes

**TaskExecutor behavior changes for async statuses:**

- **`working` status**: Now returns immediately as a successful result (`success: true`, `status: 'working'`) instead of polling until completion or timeout. Callers should use the returned `taskId` to poll for completion or set up webhooks.

- **`input-required` status**: Now returns as a successful paused state (`success: true`, `status: 'input-required'`) instead of throwing `InputRequiredError` when no handler is provided. Access the input request via `result.metadata.inputRequest`.

**Migration:**

```typescript
// Before: catching InputRequiredError
try {
  const result = await executor.executeTask(agent, task, params);
} catch (error) {
  if (error instanceof InputRequiredError) {
    // Handle input request
  }
}

// After: checking result status
const result = await executor.executeTask(agent, task, params);
if (result.status === 'input-required') {
  const { question, field } = result.metadata.inputRequest;
  // Handle input request
}
```

**Conversation context changes:**

- `wasFieldDiscussed(field)`: Now returns `true` only if the agent explicitly requested that field via an `input-required` response (previously checked if any message contained the field).

- `getPreviousResponse(field)`: Now returns the user's response to a specific field request (previously returned any message content containing the field).

### New Features

- Added v3 protocol testing scenarios:
  - `capability_discovery` - Test `get_adcp_capabilities` and verify v3 protocol support
  - `governance_property_lists` - Test property list CRUD operations
  - `governance_content_standards` - Test content standards listing and calibration
  - `si_session_lifecycle` - Test full SI session: initiate → messages → terminate
  - `si_availability` - Quick check for SI offering availability

- Exported `ProtocolClient` and related functions from main library for testing purposes
