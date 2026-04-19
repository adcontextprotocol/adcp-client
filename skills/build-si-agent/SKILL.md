---
name: build-si-agent
description: Use when building an AdCP sponsored intelligence agent — a platform that serves conversational sponsored content within user sessions.
---

# Build a Sponsored Intelligence Agent

## Overview

A sponsored intelligence (SI) agent serves conversational sponsored content within user sessions. Buyers discover offerings, initiate sessions, exchange messages, and terminate when done. The agent manages session state and delivers sponsored content in conversational form.

## When to Use

- User wants to build an agent that serves sponsored conversational content
- User mentions sponsored intelligence, SI sessions, conversational ads, or sponsored chat
- User references `si_initiate_session`, `si_send_message`, or the SI protocol

**Not this skill:**

- Selling display/video inventory → `skills/build-seller-agent/`
- Serving audience segments → `skills/build-signals-agent/`
- Managing creatives → `skills/build-creative-agent/`

## Before Writing Code

### 1. What Offerings?

Each offering represents a sponsored content experience. Define:

- Product/brand being sponsored
- Content style (informational, promotional, interactive)
- Supported modalities: conversational (text), rich_media (images/video)

### 2. Session Behavior

How should the agent respond during a session?

- **Informational** — answers questions about the sponsored product
- **Promotional** — proactively highlights features and benefits
- **Interactive** — guided product exploration with branching content

## Tools and Required Response Shapes

**`get_adcp_capabilities`** — register first, empty `{}` schema

```
capabilitiesResponse({
  adcp: { major_versions: [3] },
  supported_protocols: ['sponsored_intelligence'],
})
```

**`si_get_offering`** — `SIGetOfferingRequestSchema.shape`

Check if an offering is available. Return `available: true` with an `offering_token` the buyer passes to `si_initiate_session`.

```
taskToolResponse({
  available: true,            // required — boolean
  offering_token: string,     // token for session initiation
  ttl_seconds: 300,           // how long the token is valid
})
```

**`si_initiate_session`** — `SIInitiateSessionRequestSchema.shape`

Create a new session. Return `session_id` and `session_status`.

```
taskToolResponse({
  session_id: string,         // required — unique session identifier
  session_status: 'active',   // required — NB: 'session_status' not 'status'
})
```

**`si_send_message`** — `SISendMessageRequestSchema.shape`

Process a user message and return sponsored content.

```
taskToolResponse({
  session_id: string,         // required — echo from request
  session_status: 'active',   // required
  response: {
    content: string,          // the sponsored content text
    content_type: 'text',
  },
})
```

**`si_terminate_session`** — `SITerminateSessionRequestSchema.shape`

End the session.

```
taskToolResponse({
  session_id: string,         // required — echo from request
  terminated: true,           // required — boolean confirming termination
})
```

### Context and Ext Passthrough

Every AdCP request includes an optional `context` field. Buyers use it to carry correlation IDs, orchestration metadata, and workflow state across multi-agent calls. Your agent **must** echo the `context` object back unchanged in every response.

```typescript
// In every tool handler:
const context = args.context; // may be undefined — that's fine

// In every response:
return taskToolResponse({
  // ... your response fields ...
  context,  // echo it back unchanged
});
```

Do not modify, inspect, or omit the context — treat it as opaque. If the request has no context, omit it from the response.

## SDK Quick Reference

| SDK piece                                               | Usage                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `createAdcpServer({ name, sponsoredIntelligence })`   | Create server with domain-grouped handlers and auto-generated capabilities |
| `serve(() => createAdcpServer(...))`                    | Start HTTP server on `:3001/mcp`                                    |
| `ctx.store`                                             | State persistence — `get/put/patch/delete/list` domain objects      |
| `adcpError(code, { message })`                          | Structured error                                                    |

Handlers return raw data objects. The framework auto-wraps responses and auto-generates `get_adcp_capabilities` from registered handlers.

Import: `import { createAdcpServer, serve, adcpError } from '@adcp/client';`

## Setup

```bash
npm init -y
npm install @adcp/client
npm install -D typescript @types/node
```

Minimal `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist"
  }
}
```

`skipLibCheck: true` avoids false-positive errors from transitive `.d.ts` files (e.g., `@opentelemetry/api`).

## Implementation

1. Single `.ts` file — use `createAdcpServer` with the `sponsoredIntelligence` domain group
2. Do not register `get_adcp_capabilities` — the framework generates it from registered handlers
3. Return raw data objects from handlers — the framework wraps responses automatically
4. Use `ctx.store` to persist active sessions — track state: active → terminated
5. Handlers receive `(params, ctx)` — `ctx.store` for state, `ctx.account` for resolved account

```typescript
import { randomUUID } from 'node:crypto';
import { createAdcpServer, serve, adcpError } from '@adcp/client';
import { createIdempotencyStore, memoryBackend } from '@adcp/client/server';

const idempotency = createIdempotencyStore({
  backend: memoryBackend(),
  ttlSeconds: 86400,
});

serve(() => createAdcpServer({
  name: 'SI Agent',
  version: '1.0.0',
  idempotency,
  // Principal scope for idempotency. MUST never return undefined. A
  // constant is fine for a demo; for multi-tenant production, type the
  // account via `createAdcpServer<MyAccount>({...})` and use
  // `(ctx) => ctx.account?.id`. The framework additionally auto-scopes
  // `si_send_message` by `session_id`, so the same key under two
  // sessions doesn't cross-replay.
  resolveSessionKey: () => 'default-principal',

  sponsoredIntelligence: {
    getOffering: async (params, ctx) => ({
      available: true,
      offering_token: `tok_${randomUUID()}`,
      ttl_seconds: 300,
    }),
    initiateSession: async (params, ctx) => {
      // session_id MUST be high-entropy (≥122 bits) per spec — it's the
      // scope key for conversational isolation. Never use Date.now() or
      // predictable counters; a guessable session_id lets one buyer
      // impersonate another's session.
      const sessionId = `sess_${randomUUID()}`;
      await ctx.store.put('session', sessionId, { status: 'active' });
      return {
        session_id: sessionId,
        session_status: 'active',
      };
    },
    sendMessage: async (params, ctx) => {
      const session = await ctx.store.get('session', params.session_id);
      // Return the error — the framework echoes returned adcpError
      // responses verbatim. Thrown errors are caught and converted to
      // SERVICE_UNAVAILABLE, which hides your custom code from the buyer.
      if (!session) return adcpError('RESOURCE_NOT_FOUND', { message: 'Session not found' });
      return {
        session_id: params.session_id,
        session_status: 'active' as const,
        response: {
          content: 'Sponsored content response',
          content_type: 'text',
        },
      };
    },
    terminateSession: async (params, ctx) => {
      await ctx.store.delete('session', params.session_id);
      return {
        session_id: params.session_id,
        terminated: true,
      };
    },
  },
}));
```

## Idempotency

AdCP v3 requires an `idempotency_key` on every mutating request — for SI agents that's `si_initiate_session` and `si_send_message`. `si_terminate_session` is exempt (naturally idempotent via `session_id`; terminating a terminated session is a no-op, and its schema keeps `idempotency_key` optional). `si_get_offering` is read-only.

Idempotency is wired in the example above. What the framework handles for you:

- Rejects missing or malformed `idempotency_key` with `INVALID_REQUEST`. The spec pattern is `^[A-Za-z0-9_.:-]{16,255}$` — short test keys like `"key1"` fail length, not idempotency logic.
- **`si_send_message` is auto-scoped by `session_id`** in addition to the principal. The same `idempotency_key` used across two sessions does NOT cross-replay — each session has its own idempotency namespace. You don't have to implement this; the framework does it.
- JCS-canonicalized payload hashing; `IDEMPOTENCY_CONFLICT` on same-key-different-payload (no payload leak — error body is code + message only).
- `IDEMPOTENCY_EXPIRED` past the TTL (±60s clock-skew tolerance).
- `replayed: true` on `result.structuredContent.replayed` for cache hits; fresh executions omit the field.
- Auto-declares `adcp.idempotency.replay_ttl_seconds` on `get_adcp_capabilities`.
- Only successful responses cache — a failed generation re-executes on retry so buyers can safely retry transient errors without burning the key or double-billing.

`ttlSeconds` must be in `[3600, 604800]` — out of range throws at `createIdempotencyStore` construction. Don't pass minutes thinking they're seconds.

## Validation

```bash
npx tsx agent.ts &
npx @adcp/client storyboard run http://localhost:3001/mcp si_session --json
```

**Keep iterating until all steps pass.**

## Common Mistakes

| Mistake                                              | Fix                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Manually registering `get_adcp_capabilities`         | Framework auto-generates it from registered handlers — do not register it yourself |
| Using `server.tool()` instead of domain groups       | Use `sponsoredIntelligence: { getOffering, initiateSession, ... }` — framework wires schemas and response builders |
| Using in-memory Maps for session state               | Use `ctx.store.put/get/delete` — built-in state persistence            |
| Returns `status` instead of `session_status`         | Field name is `session_status` — `status` will fail schema validation  |
| Returns `status: 'terminated'` instead of `terminated: true` | Termination response uses boolean `terminated` field          |
| Missing `session_id` in si_send_message response     | Echo `session_id` back from request — required                         |
| Missing `available` in si_get_offering               | Boolean `available` is required — even for mock data                   |
| Missing `reason` in si_terminate_session request     | `reason` is required — one of: `user_exit`, `session_timeout`, `host_terminated`, `handoff_transaction`, `handoff_complete` |
| Dropping `context` from responses              | Echo `args.context` back unchanged in every response — buyers use it for correlation |

## Storyboards

| Storyboard    | Tests                                                            |
| ------------- | ---------------------------------------------------------------- |
| `si_session`  | Full session lifecycle: offering → initiate → message → terminate |

## Reference

- `storyboards/si_session.yaml` — full SI session storyboard
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
