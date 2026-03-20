# Webhook & Async Compliance Scenarios for `comply`

**Status:** Proposal
**Date:** 2026-03-19

## Problem

AdCP defines a rich async architecture — push notifications, reporting webhooks, artifact webhooks, task status transitions — but `comply` only tests synchronous request/response behavior. We have no way to verify that agents:

1. Accept `push_notification_config` parameters
2. Actually deliver webhook payloads
3. Format payloads per the `mcp-webhook-payload.json` schema
4. Implement proper auth (Bearer or HMAC-SHA256) on webhook delivery
5. Emit correct task status transitions (`submitted` → `working` → `completed`/`failed`)
6. Handle long-running operations correctly (return `submitted` status, then deliver results async)

## What AdCP Defines

### Push Notification Config

Accepted by: `create_media_buy`, `update_media_buy`, `sync_creatives`, `sync_audiences`, `sync_catalogs`

```json
{
  "url": "https://buyer.example.com/webhooks/adcp",
  "token": "client-validation-token-min16chars",
  "authentication": {
    "schemes": ["HMAC-SHA256"],
    "credentials": [{ "hmac_secret": "shared-secret-min-32-chars..." }]
  }
}
```

### Webhook Payload (MCP)

```json
{
  "operation_id": "op_abc123",
  "task_id": "task_xyz",
  "task_type": "create_media_buy",
  "domain": "media-buy",
  "status": "completed",
  "timestamp": "2026-03-19T10:30:00Z",
  "message": "Media buy created successfully",
  "result": { /* async response data */ }
}
```

### Task Status Transitions

```
submitted → working → completed
                   → failed
                   → input-required → (resume) → working → completed
```

### Reporting Webhooks

Periodic delivery of campaign performance data:

```json
{
  "reporting_frequency": "daily",
  "requested_metrics": ["impressions", "clicks", "spend"]
}
```

## Design

### New Track: `async`

Add an `async` capability track. Unlike `error_handling` (always applicable), this track is only applicable when the agent advertises async-capable tools (`create_media_buy`, `sync_creatives`, etc.).

### How to Test Webhooks

The key challenge: `comply` is a CLI tool running on the tester's machine. Agents need to deliver webhooks to a URL the tester controls.

**Approach: Ephemeral webhook receiver.**

`comply` spins up a temporary HTTP server on a random port, passes its URL as `push_notification_config.url` in tool calls, and validates incoming payloads. For remote agents (not localhost), the receiver needs to be publicly reachable.

Options:
1. **Local mode** (agent on localhost): Receiver binds to `127.0.0.1:PORT`. Works when testing local agents.
2. **Tunnel mode** (remote agents): Use a reverse tunnel (ngrok, cloudflared) to expose the local receiver. Comply could auto-detect and offer to start a tunnel.
3. **Callback URL mode**: User provides their own webhook endpoint (e.g., a deployed service) via `--webhook-url`. Comply polls that endpoint for received payloads.

**Recommended for v1: Local mode only.** Most comply testing happens against local dev agents. Remote webhook testing is a harder problem that can come later.

### Scenario Definitions

#### `async_acceptance` — Push Notification Config Acceptance

Verify that tools accept `push_notification_config` without errors.

```
1. Call create_media_buy (or first async-capable tool) with push_notification_config
2. Verify the tool doesn't reject the config
3. Check response for task status (submitted/working/completed)
4. If response is synchronous (completed immediately), that's fine — note it
```

Pass criteria: Tool accepts push_notification_config parameter without error.

#### `async_status_transitions` — Task Status Lifecycle

Verify correct status transitions for long-running operations.

```
1. Call create_media_buy with a valid request
2. If response status is 'submitted' or 'working':
   a. Verify response includes task_id
   b. Verify response includes operation_id (if we provided one)
   c. If 'working': check for progress fields (percentage, current_step)
   d. Wait for completion (poll or webhook)
   e. Verify final status is 'completed' or 'failed'
3. If response is immediately 'completed': pass (agent does sync processing)
```

Pass criteria: Status transitions follow the valid state machine. No invalid transitions (e.g., `completed` → `working`).

#### `webhook_delivery` — Payload Format and Delivery (local mode only)

Verify webhook payloads match the `mcp-webhook-payload.json` schema.

```
1. Start ephemeral HTTP server on random port
2. Call create_media_buy with push_notification_config.url = http://localhost:PORT/webhook
3. Wait up to 30 seconds for webhook delivery
4. Validate received payload:
   a. Has required fields: operation_id, task_id, task_type, domain, status, timestamp
   b. task_type matches the tool called
   c. status is a valid TaskStatus enum value
   d. timestamp is valid ISO 8601
   e. If status is completed, result field contains valid async response data
5. Shut down server
```

Pass criteria: Webhook delivered with valid payload schema. If no webhook received within timeout, fail with "Agent accepted push_notification_config but did not deliver webhook."

#### `webhook_auth` — Authentication Scheme Validation

Verify webhook delivery includes proper authentication.

```
1. Start ephemeral server
2. Call tool with push_notification_config including HMAC-SHA256 auth:
   {
     url: "http://localhost:PORT/webhook",
     authentication: {
       schemes: ["HMAC-SHA256"],
       credentials: [{ hmac_secret: "test-secret-minimum-32-characters-long" }]
     }
   }
3. On webhook receipt, validate:
   a. Request includes X-Webhook-Signature header (or similar)
   b. Signature matches HMAC-SHA256(body, secret)
   c. Content-Type is application/json
4. Also test Bearer token auth:
   a. Configure with Bearer scheme
   b. Verify Authorization: Bearer <token> header
```

Pass criteria: Auth scheme correctly applied to webhook delivery.

#### `reporting_webhook` — Periodic Reporting Config

Verify agents accept reporting webhook configuration.

```
1. Create a media buy with reporting_webhook config:
   {
     url: "http://localhost:PORT/reporting",
     reporting_frequency: "hourly",
     requested_metrics: ["impressions", "clicks"]
   }
2. Verify tool accepts the config without error
3. (We can't wait for hourly delivery in a test, so acceptance is sufficient)
4. If agent supports get_media_buy_delivery, verify it returns the requested metrics
```

Pass criteria: Agent accepts reporting_webhook configuration.

### Compliance Levels

| Level | What we check |
|-------|--------------|
| **L1** | Agent accepts push_notification_config without error |
| **L2** | L1 + correct status transitions + webhook delivered with valid schema |
| **L3** | L2 + webhook auth (HMAC-SHA256 or Bearer) correctly implemented |

### Integration with Error Compliance

Async errors should follow the transport error mapping spec. If a webhook delivery fails, the agent should return a structured error explaining why (e.g., `INVALID_REQUEST` with `field: "push_notification_config.url"` and `suggestion: "URL must be reachable"`).

The error compliance track validates error structure; the async track validates async behavior. They're complementary.

### Reporting

```
Async  L2  3/4 scenarios pass  (12.5s)
   ✅ async_acceptance (push_notification_config accepted)
   ✅ async_status_transitions (submitted → working → completed)
   ✅ webhook_delivery (valid payload, 1.2s delivery time)
   ❌ webhook_auth (no signature header on HMAC-SHA256 delivery)
   Async Compliance: Level 2
     ✓ Accepts push_notification_config
     ✓ Correct status transitions
     ✓ Webhook payload matches schema
     ✗ HMAC-SHA256 signature not implemented
```

### Observations

| Condition | Severity | Message |
|-----------|----------|---------|
| Agent doesn't accept push_notification_config | warning | "Agent does not support async notifications. Buyers cannot receive task status updates." |
| Immediate completion on all tools | info | "Agent processes all requests synchronously. Async support not needed for current tool set." |
| Webhook delivered but no auth | warning | "Webhook delivered without authentication. Use HMAC-SHA256 for production." |
| Webhook not delivered within timeout | error | "Agent accepted push_notification_config but did not deliver webhook within 30s." |
| Invalid webhook payload schema | error | "Webhook payload missing required fields. See mcp-webhook-payload.json." |
| Slow webhook delivery (>5s) | suggestion | "Webhook delivered in Xs. Consider async delivery for faster buyer notification." |

### Configuration

```bash
# Run async track (local webhook receiver)
adcp comply test-mcp --track async

# Skip async track
adcp comply test-mcp --skip-track async

# Provide external webhook URL (future)
adcp comply test-mcp --webhook-url https://my-endpoint.example.com/webhooks
```

### CLI Flag: `--webhook-port`

For local testing, allow specifying the webhook receiver port:

```bash
adcp comply test-mcp --track async --webhook-port 9876
```

Default: random available port.

## Implementation Plan

### Stage 1: Ephemeral Webhook Receiver

Create a lightweight HTTP server that:
- Binds to localhost on a random (or specified) port
- Collects incoming POST requests with payloads
- Validates HMAC-SHA256 signatures when configured
- Times out after a configurable period
- Returns collected payloads for scenario validation

**Files:**
- `src/lib/testing/webhook-receiver.ts`

### Stage 2: Async Scenarios

**Files:**
- `src/lib/testing/scenarios/async-compliance.ts` — `testAsyncAcceptance()`, `testAsyncStatusTransitions()`, `testWebhookDelivery()`, `testWebhookAuth()`, `testReportingWebhook()`

### Stage 3: Comply Integration

- Add `async` track to types, comply orchestrator, profiles
- Add `--webhook-port` CLI flag
- Wire up webhook receiver lifecycle (start before async scenarios, stop after)

## Open Questions

1. **Remote webhook testing**: How do we test webhooks against remote agents? Tunneling adds complexity and a dependency. Is "local mode only" sufficient for v1?

2. **Timeout for long-running operations**: Some async operations (media buy creation) may take minutes. How long should comply wait? Suggest 30s default with `--async-timeout` flag.

3. **Reporting webhook verification**: We can verify the agent accepts the config, but we can't wait for hourly/daily delivery. Is acceptance testing sufficient, or should we have a way to trigger immediate delivery for testing?

4. **A2A async patterns**: A2A has native push notifications via `TaskStatusUpdateEvent`. Should we test these separately, or is the webhook test sufficient since both use the same underlying push_notification_config?
