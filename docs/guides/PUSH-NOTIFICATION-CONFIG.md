# Push Notification Config

Push notification config tells the AdCP agent where to send async task status updates via webhook. Since AdCP 3.2.0-beta.5 it is application-layer request data on MCP, A2A, and REST. The client injects it automatically when `webhookUrlTemplate` is configured.

## How It Works

When you configure a `webhookUrlTemplate`, every outgoing tool call (`create_media_buy`, `update_media_buy`, `sync_creatives`, etc.) can include a `push_notification_config`. The URL is generated per operation. Omitting `webhookSecret` selects the current RFC 9421 signature profile; setting it explicitly selects legacy HMAC-SHA256.

## Client Setup

```typescript
const client = new AdCPClient({
  webhookUrlTemplate: 'https://your-app.com/adcp/webhook/{task_type}/{agent_id}/{operation_id}',
});
```

## Wire Payload

The default RFC 9421 registration has no `authentication` block:

```json
{
  "push_notification_config": {
    "url": "https://your-app.com/adcp/webhook/create_media_buy/agent_123/cd51e063-2b79-4a6d-afac-ed7789c3a443",
    "operation_id": "cd51e063-2b79-4a6d-afac-ed7789c3a443"
  }
}
```

Setting `webhookSecret` opts into the legacy shape:

```json
{
  "push_notification_config": {
    "url": "https://your-app.com/adcp/webhook/create_media_buy/agent_123/cd51e063-2b79-4a6d-afac-ed7789c3a443",
    "operation_id": "cd51e063-2b79-4a6d-afac-ed7789c3a443",
    "authentication": {
      "schemes": ["HMAC-SHA256"],
      "credentials": "your-hmac-secret-min-32-characters-here"
    }
  }
}
```

## `create_media_buy` — Full Example

`create_media_buy` also includes a separate `reporting_webhook` for ongoing delivery metrics. These are independent:

```json
{
  "name": "create_media_buy",
  "arguments": {
    "buyer_ref": "mb_abc123",
    "start_time": "2026-03-01T00:00:00Z",
    "end_time": "2026-04-01T00:00:00Z",
    "brand_manifest": {
      "url": "https://example.com",
      "name": "Example Brand"
    },
    "packages": [...],
    "reporting_webhook": {
      "url": "https://your-app.com/adcp/webhook/media_buy_delivery/agent_123/delivery_report_agent_123_2026-03",
      "authentication": {
        "schemes": ["HMAC-SHA256"],
        "credentials": "your-hmac-secret-min-32-characters-here"
      },
      "reporting_frequency": "daily",
      "requested_metrics": ["impressions", "spend", "clicks"]
    },
    "push_notification_config": {
      "url": "https://your-app.com/adcp/webhook/create_media_buy/agent_123/cd51e063-2b79-4a6d-afac-ed7789c3a443",
      "operation_id": "cd51e063-2b79-4a6d-afac-ed7789c3a443",
      "authentication": {
        "schemes": ["HMAC-SHA256"],
        "credentials": "your-hmac-secret-min-32-characters-here"
      }
    }
  }
}
```

## `sync_creatives` — Full Example

```json
{
  "name": "sync_creatives",
  "arguments": {
    "creatives": [...],
    "push_notification_config": {
      "url": "https://your-app.com/adcp/webhook/sync_creatives/agent_123/f3a9b2c1-1234-5678-abcd-ef0123456789",
      "operation_id": "f3a9b2c1-1234-5678-abcd-ef0123456789",
      "authentication": {
        "schemes": ["HMAC-SHA256"],
        "credentials": "your-hmac-secret-min-32-characters-here"
      }
    }
  }
}
```

## `reporting_webhook` vs `push_notification_config`

| | `push_notification_config` | `reporting_webhook` |
|---|---|---|
| Purpose | Task status updates (submitted, complete, failed) | Ongoing campaign delivery metrics |
| Operations | All async operations | `create_media_buy` only |
| Frequency | Per task lifecycle event | Hourly / daily / monthly |
| Set by | Client auto-injects | Caller supplies in task parameters |

On A2A, this AdCP registration stays in the skill parameters as
`push_notification_config`. It is distinct from A2A's native
`configuration.pushNotificationConfig`; the SDK retains native A2A
configuration for transport compatibility without treating it as a substitute
for the application-layer registration. In-process MCP receives the same AdCP
argument as remote MCP.

For beta.5, sellers reject a registration whose `operation_id` is missing or
does not match `^[A-Za-z0-9_.:-]{1,255}$`. The SDK reuses the operation identity
created by `TaskExecutor`, so the request, registration record, webhook route,
and returned webhook envelope all correlate on the same value.

As with MCP, a modern governed A2A request cannot disclose an HMAC credential
to the governance service while also authorizing the exact seller argument
object. The SDK fails closed for that combination; use RFC 9421 (omit
`webhookSecret`), set `{ disableWebhook: true }` and poll, or use an application
flow whose governance boundary can safely authorize the callback configuration.

## Authentication

### RFC 9421 (default)

`SingleAgentClient` records the exact callback URL, seller, protocol, task, and selected authentication mode before dispatch. `verifyAndParseWebhook` then resolves the registered seller's keys through its capabilities → `brand.json` → `agents[].jwks_uri` chain and verifies the RFC 9421 signature, content digest, signature window, revocation, and nonce replay protection.

The receiver must supply exact raw bytes, the trusted route operation ID, HTTP method, and the externally visible absolute URL. Do not derive the public URL from untrusted `Host` or `X-Forwarded-*` headers. Behind a trusted reverse proxy, construct it from server-owned configuration:

```typescript
app.post(
  '/adcp/webhook/:task_type/:agent_id/:operation_id',
  express.raw({ type: 'application/json' }),
  client.createWebhookHandler({
    getRequestUrl: req => `https://your-app.com${req.originalUrl}`,
  }),
);
```

The default registration and replay stores are process-local. Production receivers that can restart or run multiple replicas must inject a shared durable `webhookRegistrationStore` and `webhookVerification.replayStore`; registration writes must be atomic create-or-identical, and replay insertion must be atomic across replicas. Retain registrations for at least the seller retry horizon (seven days by default).

Custom registration stores used by durability-protected mutation flows must also implement `markRequiresDurableSettlement(agentId, operationId)` as an atomic update of the live registration. The SDK calls this after registration but before claiming or dispatching the mutation. If the method is absent or the update fails, dispatch fails closed.

For deterministic tests or infrastructure-managed keys, set `webhookVerification.jwks`. Otherwise seller key discovery is automatic and uses an unauthenticated official protocol client for the capabilities step, so credentials configured for one endpoint are never transplanted to the registered callback origin. Sellers whose capability discovery requires authentication should provide an origin-bound `webhookVerification.fetchCapabilities(agentUrl, protocol)` callback or inject `webhookVerification.jwks` directly.

When a cross-origin seller is authorized through a constrained
`brand.json.authorized_operators[]` entry, also configure the trusted
`webhookVerification.resolverOptions.requiredOperatorBrand`,
`requiredOperatorScope`, and/or `requiredOperatorCountry` values that select the
intended grant. Narrow brand, scope, or country lists fail closed without this
context. Broad grants use `brands: ['*']`, omitted scopes (or `['all']`), and
omitted countries. Delegated JWKS caches never outlive `valid_until`.
Resolver options are trusted client-wide policy; they are not inferred from
individual tool arguments. Use separate clients/resolvers for operations with
different constrained brand, scope, or country tuples.

### Legacy HMAC-SHA256

When `webhookSecret` is configured, the legacy webhook authentication path uses `HMAC-SHA256`. The agent signs `${timestamp}.${raw_body_bytes}` with the shared secret and sends:

- `x-adcp-signature: sha256=<hex digest>`
- `x-adcp-timestamp: <unix seconds>`

HMAC registration provenance never stores the credential or a secret-derived fingerprint. The configured global `webhookSecret` remains the verification key. Recordless fallback is limited to an explicit set of read-only tasks; mutations, unknown extensions, and `get_products` (which has a state-changing legacy finalization variant) require a live trusted registration and fail closed when registration state is missing or unavailable. RFC 9421 always fails closed without seller-pinned provenance.

Capture the raw request body before JSON parsing and use the SDK's HTTP handler,
which verifies the signature and preserves typed failure status codes:

```typescript
app.post(
  '/adcp/webhook/:task_type/:agent_id/:operation_id',
  express.raw({ type: 'application/json' }),
  client.createWebhookHandler({
    getRequestUrl: req => `https://buyer.example${req.originalUrl}`,
  }),
);
```

The handler normalizes header casing, rejects missing or ambiguous signature
headers, enforces the freshness/replay checks, and compares signatures in
constant time. It returns 401 only for authentication failures; invalid or
conflicting deliveries use 400/409, rate abuse uses 429, and transient
verification, storage, or publication failures use 503 so the seller retries.
Use `webhookDedup` below to drop duplicate webhook events by `idempotency_key`.

The mode recorded at registration is authoritative. The receiver never tries RFC 9421 and falls back to HMAC (or vice versa), and mixed-mode headers fail with `webhook_mode_mismatch`.

`reporting_webhook` and artifact callbacks are separate registrations. The automatic provenance described above covers task-status `push_notification_config`; existing reporting webhook HMAC verification remains recordless for compatibility.

## Deduplication

AdCP webhooks use at-least-once delivery — publishers retry until they see a 2xx response, so the same event can arrive more than once. Every MCP webhook payload carries a required `idempotency_key` for one delivery identity. Beta.5 can re-emit the same terminal task under another delivery key; the receiver therefore also fences terminal publication by authenticated seller, buyer `operation_id`, and seller `task_id`. Optional `notification_id` is preserved as logical-event evidence and conflicting reuse fails closed.

Wire the client's `webhookDedup` on the `AsyncHandler` to get this for free:

```typescript
import { AdCPClient } from '@adcp/sdk';
import { memoryBackend } from '@adcp/sdk/server';

const client = new AdCPClient(agents, {
  webhookUrlTemplate: 'https://your-app.com/adcp/webhook/{task_type}/{agent_id}/{operation_id}',
  webhookSecret: process.env.WEBHOOK_SECRET,
  handlers: {
    webhookDedup: { backend: memoryBackend(), ttlSeconds: 86_400 }, // 24h
    onCreateMediaBuyStatusChange: async (result, metadata) => {
      // One terminal publication runs here, even if it is re-emitted under
      // another delivery idempotency_key.
    },
  },
});
```

Scope is per-agent so keys from different senders never collide. Swap `memoryBackend()` for `pgBackend(...)` when running multiple replicas — the same backend can be shared with the request-side idempotency store. New hashed sender scopes use the reserved `adcp\u001fwebhook\u001fv2\u001f…` namespace; v1 is read only for migration of unexpired raw-agent fences written by older SDKs.

### Activity stream emits both events

On a duplicate the typed handler (e.g. `onCreateMediaBuyStatusChange`) is NOT called, but the `onActivity` stream DOES fire — once as `webhook_received` for the first delivery and once as `webhook_duplicate` for each retry. If you wire side effects into `onActivity`, branch on `activity.type` so metrics and logs don't double-count:

```typescript
onActivity: (activity) => {
  if (activity.type === 'webhook_duplicate') {
    metrics.increment('webhook.duplicate', { agent: activity.agent_id });
    return;
  }
  if (activity.type === 'webhook_received') {
    metrics.increment('webhook.received', { agent: activity.agent_id });
  }
},
```

The `webhook_duplicate` event intentionally omits `payload` (the original `webhook_received` already carries it) but includes `idempotency_key` on both events for correlation.

### Migrating from ad-hoc dedup

If you previously tracked processed webhooks by `(task_id, status, timestamp)`, replace that with `webhookDedup`. The SDK keeps delivery-key replay protection separate from beta.5 terminal-task convergence, avoiding timestamp-based collisions while still detecting one delivery key reused with changed content.

### A2A and missing keys

Structured A2A webhook data can carry `idempotency_key`, and the client preserves it for deduplication. When `webhookDedup` is configured, every MCP and A2A delivery must provide the field and it must match the spec regex `^[A-Za-z0-9_.:-]{16,255}$`; missing or malformed keys fail closed before handlers run so non-conforming input cannot bypass configured deduplication. Older A2A senders that cannot emit the field must leave receiver dedup disabled.

Handler and activity failures are not acknowledged: the HTTP helper returns an
error so the publisher retries. A concurrent retry while the same event is
still being handled receives `503`; the owner-fenced processing claim renews
until the active handler finishes. By default, processing claims use the full
`ttlSeconds` retention window (24 hours by default), preventing automatic
reclaim while an unconstrained application handler might still be applying
side effects. Setting a shorter `inFlightTtlSeconds` explicitly trades that
fence for faster crash recovery. It must not exceed `ttlSeconds` (24 hours by
default); invalid configurations fail at handler construction. Because the SDK cannot cancel or
transactionally fence a generic handler, handlers using the shorter lease must
durably deduplicate `(agent_id, idempotency_key, event fingerprint)` or make
their side effects idempotent. Webhook delivery remains at-least-once.
The SDK retains the active event fingerprint for the full `ttlSeconds` even
when a shorter processing lease expires. Only an exact-payload retry may
reclaim that expired lease; reusing the sender key for a changed payload remains
a typed conflict throughout the dedup window.

Custom idempotency backends used for webhook dedup must implement the atomic
`putIfAbsent()`, `replaceIfPayloadHash()`, `replaceIfPayloadHashAndExpired()`,
and `deleteIfPayloadHash()` methods. The built-in
memory, PostgreSQL, Redis, and lazy backends provide them. These operations
prevent a stale replica from renewing or releasing a newer replica's claim.
The expired-owner replacement must atomically test both the expected payload
hash and backend-time logical expiry; an entry expiring in the current second
is still live. Do not implement it as a read followed by ordinary replacement,
because a same-token renewal creates an ABA takeover race.
`putIfAbsent()` is absent-only and must not replace a retained expired entry;
all expired-generation reclaim goes through the exact-owner method.

SDK 14 writes webhook fences under a hashed sender scope. During the upgrade it
also reads an unexpired marker written by the previous receiver version under
its raw sender scope, so a
callback completed before deployment remains a duplicate instead of running the
handler again. The compatibility lookup never writes or renews the old key;
after its original TTL expires, only the hashed scope remains active.

The namespace change is not safe for a mixed rolling deployment: old and new
receivers claim different keys and can dispatch the same callback once each.
Before upgrading, stop accepting webhook traffic, drain in-flight handlers,
upgrade every receiver replica together, and only then restart webhook traffic.
Mixed SDK 13/14 webhook receivers are unsupported. The legacy read preserves
already-completed fences across the cutover; it does not coordinate concurrent
old and new receivers.
