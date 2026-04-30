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

## Specialisms This Skill Covers

| Specialism   | Status | Delta                                                                                                                                                                                     |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none yet)_ | —      | SI has no specialisms in AdCP 3.0 — pass the `sponsored_intelligence` *protocol* baseline (declared via `supported_protocols: ['sponsored_intelligence']`). Specialism storyboards for conversational-ad-specific patterns are pending future AdCP releases. |

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

> **Before writing any handler's return statement, fetch [`docs/llms.txt`](../../docs/llms.txt) and grep for `#### \`<tool_name>\``(e.g.`#### \`si_initiate_session\``) to read the exact required + optional field list.** The schema-derived contract lives there; this skill covers patterns, gotchas, and domain-specific examples. Strict response validation is on by default in dev — it will tell you the exact field path if you drift, so write the obvious thing and trust the contract.
>
> **Cross-cutting pitfalls matrix runs keep catching:**
>
> - **Do NOT declare a `sponsored-intelligence` specialism.** SI is a *protocol* in AdCP 3.0 — declared via `supported_protocols: ['sponsored_intelligence']` on the `get_adcp_capabilities` response. There is no SI specialism in the `AdCPSpecialism` enum yet, so adopters wire SI through the v5 handler-bag path (`createAdcpServer` from `@adcp/sdk/server/legacy/v5`). The v6 `DecisioningPlatform` interface does not yet expose a `sponsoredIntelligence` field. (Tracking: SI specialism + auto-hydration of `req.session` is planned for a later v6.x — adopters today persist sessions explicitly via `ctx.store`.)

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

The framework auto-echoes the request's `context` into every response — **do not set `context` yourself** on responses for tools whose request-side `context` is the protocol echo object (`core/context.json`).

**SI override.** `si_get_offering` and `si_initiate_session` override `context` on the request as a domain-specific **string** (natural-language intent hint, per spec: _'mens size 14 near Cincinnati'_). The response schema still keeps `context` as the protocol echo object. The framework detects this mismatch and skips the auto-echo for non-object values — your response simply won't carry a `context` field unless you populate it. If you want correlation tracking for SI responses, construct the context object in your handler (e.g., from a buyer-supplied `ext.correlation_id` or your own generator) and return it on the response.

`si_send_message` and `si_terminate_session` use the standard protocol echo object on both sides — leave `context` out of the handler return and the framework will echo it.

## SDK Quick Reference

| SDK piece                                                            | Usage                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `createAdcpServer(config)` *(use this for SI)*                       | v5 handler-bag entry. The only path that ships SI dispatch (the `sponsoredIntelligence: { getOffering, initiateSession, sendMessage, terminateSession }` sub-bag). Reach via `@adcp/sdk/server/legacy/v5`. v6 `createAdcpServerFromPlatform` does not yet expose an SI specialism — when it does, this skill will document the migration. |
| `serve(() => createAdcpServer(config))`                              | Start HTTP server on `:3001/mcp`                                                                                                                                                                                                                                                                                                                                                |
| `ctx.store`                                                          | State persistence — `get/put/patch/delete/list` domain objects. SI sessions live here today (no auto-hydration yet).                                                                                                                                                                                                                                                            |
| `adcpError(code, { message })`                                       | Structured error                                                                                                                                                                                                                                                                                                                                                               |

Handlers return raw data objects. The framework auto-wraps responses and auto-generates `get_adcp_capabilities` from registered handlers.

Import: `import { createAdcpServer, serve, adcpError } from '@adcp/sdk/server/legacy/v5';`

## Setup

```bash
npm init -y
npm install @adcp/sdk
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

1. Single `.ts` file — wire `createAdcpServer` from `@adcp/sdk/server/legacy/v5` with a `sponsoredIntelligence` handler bag
2. Do not register `get_adcp_capabilities` — the framework generates it from registered handlers
3. Return raw data objects from handlers — the framework wraps responses automatically
4. Use `ctx.store` to persist active sessions — track state: active → terminated. **Sessions are NOT auto-hydrated yet** (planned for v6.x). Read `req.session_id` and look the session up in `ctx.store` on every `si_send_message`.
5. Handlers receive `(params, ctx)` — `ctx.store` for state, `ctx.account` (when `resolveAccount` is wired) for resolved account

```typescript
import { randomUUID } from 'node:crypto';
import {
  createAdcpServer,
  serve,
  adcpError,
  createIdempotencyStore,
  memoryBackend,
} from '@adcp/sdk/server/legacy/v5';

const idempotency = createIdempotencyStore({
  backend: memoryBackend(),
  ttlSeconds: 86400,
});

serve(() =>
  createAdcpServer({
    name: 'SI Agent',
    version: '1.0.0',
    idempotency,
    // Principal scope for idempotency. MUST never return undefined. The
    // framework additionally auto-scopes `si_send_message` by `session_id`,
    // so the same key under two sessions doesn't cross-replay.
    resolveSessionKey: () => 'default-principal',
    capabilities: {
      // SI is a *protocol*, not a specialism. Declare it here; the framework
      // adds it to `get_adcp_capabilities.supported_protocols`.
      supported_protocols: ['sponsored_intelligence'],
    },
    sponsoredIntelligence: {
      getOffering: async (req, ctx) => ({
        available: true,
        offering_token: `tok_${randomUUID()}`,
        ttl_seconds: 300,
      }),
      initiateSession: async (req, ctx) => {
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
      sendMessage: async (req, ctx) => {
        // No auto-hydration of sessions yet — read explicitly. (v6.x will
        // attach `req.session` for free; until then this lookup is your
        // session-loss guard.)
        const session = await ctx.store.get('session', req.session_id);
        // Return the error — the framework echoes returned adcpError
        // responses verbatim. Thrown errors are caught and converted to
        // SERVICE_UNAVAILABLE, which hides your custom code from the buyer.
        if (!session) return adcpError('RESOURCE_NOT_FOUND', { message: 'Session not found' });
        return {
          session_id: req.session_id,
          session_status: 'active' as const,
          response: {
            content: 'Sponsored content response',
            content_type: 'text',
          },
        };
      },
      terminateSession: async (req, ctx) => {
        await ctx.store.delete('session', req.session_id);
        return {
          session_id: req.session_id,
          terminated: true,
        };
      },
    },
  })
);
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

## Protecting your agent

**An AdCP agent that accepts unauthenticated requests is non-compliant** (see `security_baseline` in the universal storyboard bundle). Ask the operator: "API key, OAuth, or both?" — then wire one of these into `serve()`.

```typescript
import { serve } from '@adcp/sdk';
import { verifyApiKey, verifyBearer, anyOf } from '@adcp/sdk/server';

// API key — simplest, good for B2B integrations
serve(createAgent, {
  authenticate: verifyApiKey({
    verify: async token => {
      const row = await db.api_keys.findUnique({ where: { token } });
      return row ? { principal: row.account_id } : null;
    },
  }),
});

// OAuth — best when buyers authenticate as themselves
const AGENT_URL = 'https://my-agent.example.com/mcp';
serve(createAgent, {
  publicUrl: AGENT_URL, // canonical RFC 8707 audience — also served as `resource` in protected-resource metadata
  authenticate: verifyBearer({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    issuer: 'https://auth.example.com',
    audience: AGENT_URL, // MUST equal publicUrl
  }),
  protectedResource: { authorization_servers: ['https://auth.example.com'] },
});

// Both
serve(createAgent, {
  publicUrl: AGENT_URL,
  authenticate: anyOf(verifyApiKey({ verify: lookupKey }), verifyBearer({ jwksUri, issuer, audience: AGENT_URL })),
  protectedResource: { authorization_servers: [issuer] },
});
```

The framework produces RFC 6750-compliant `WWW-Authenticate: Bearer` 401s on failure, and serves `/.well-known/oauth-protected-resource<mountPath>` with `publicUrl` as the `resource` field so buyers get tokens bound to the right audience. The default JWT allowlist is asymmetric-only (RS*/ES*/PS\*/EdDSA) to prevent algorithm-confusion attacks.

## Validate Locally

**Full validation checklist:** [docs/guides/VALIDATE-YOUR-AGENT.md](../../docs/guides/VALIDATE-YOUR-AGENT.md). SI-specific commands:

```bash
# Boot
npx tsx agent.ts &

# Happy path — session lifecycle
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp si_baseline --auth $TOKEN

# Cross-cutting obligations
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp \
  --storyboards security_baseline,idempotency,schema_validation,error_compliance --auth $TOKEN

# Rejection-surface fuzz
npx @adcp/sdk@latest fuzz http://localhost:3001/mcp \
  --tools si_get_offering --auth-token $TOKEN
```

Common failure decoder:

- `status` field on session response → rename to `session_status` (the canonical field name)
- `status: 'terminated'` → use boolean `terminated: true`
- Missing `session_id` on `si_send_message` response → echo from request — required
- Missing `available` boolean on `si_get_offering` → required even for mock data
- Missing `reason` on `si_terminate_session` request → enum: `user_exit` / `session_timeout` / `host_terminated` / `handoff_transaction` / `handoff_complete`

**Keep iterating until all steps pass.** Can't bind ports? `npm run compliance:skill-matrix -- --filter si` runs an isolated end-to-end test.

## Common Mistakes

| Mistake                                                      | Fix                                                                                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Manually registering `get_adcp_capabilities`                 | Framework auto-generates it from registered handlers — do not register it yourself                                                                                                                     |
| Using `server.tool()` instead of domain groups               | Use `sponsoredIntelligence: { getOffering, initiateSession, ... }` — framework wires schemas and response builders                                                                                     |
| Using in-memory Maps for session state                       | Use `ctx.store.put/get/delete` — built-in state persistence                                                                                                                                            |
| Returns `status` instead of `session_status`                 | Field name is `session_status` — `status` will fail schema validation                                                                                                                                  |
| Returns `status: 'terminated'` instead of `terminated: true` | Termination response uses boolean `terminated` field                                                                                                                                                   |
| Missing `session_id` in si_send_message response             | Echo `session_id` back from request — required                                                                                                                                                         |
| Missing `available` in si_get_offering                       | Boolean `available` is required — even for mock data                                                                                                                                                   |
| Missing `reason` in si_terminate_session request             | `reason` is required — one of: `user_exit`, `session_timeout`, `host_terminated`, `handoff_transaction`, `handoff_complete`                                                                            |
| Dropping `context` from responses                            | Let the framework echo — except for `si_get_offering` / `si_initiate_session`, whose request `context` is a string. For those, build your own response context object if correlation tracking matters. |

## Storyboards

| Storyboard   | Tests                                                             |
| ------------ | ----------------------------------------------------------------- |
| `si_session` | Full session lifecycle: offering → initiate → message → terminate |

## Reference

- `storyboards/si_session.yaml` — full SI session storyboard
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
