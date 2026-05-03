---
name: build-si-agent
description: Use when building an AdCP sponsored intelligence agent — a brand-agent platform that hosts conversational sponsored content (offering discovery, session lifecycle, ACP checkout handoff).
---

# Build a Sponsored Intelligence Agent

## Overview

A sponsored intelligence (SI) agent runs a brand-side conversational AI experience that an LLM host (ChatGPT, Claude, Perplexity, Arc, etc.) can hand off to. The buyer agent calls four tools across the session lifecycle:

1. `si_get_offering` — discover what's available, get an `offering_token`
2. `si_initiate_session` — start a conversation, receive `session_id`
3. `si_send_message` — exchange turns, optionally surface a handoff hint
4. `si_terminate_session` — end the session, optionally return ACP checkout payload

The agent owns the brand voice, transcript state, and product knowledge. The host owns the user, identity consent, and ACP checkout. SI is the AdCP surface that connects them.

## When to Use

- User wants to build a brand-agent platform that hosts conversational ads (Salesforce Agentforce, OpenAI Assistants brand mode, custom in-house brand chat).
- User mentions sponsored intelligence, SI sessions, conversational ads, brand handoff, or ACP checkout.
- User references `si_initiate_session`, `si_send_message`, `si_get_offering`, or `si_terminate_session`.

**Not this skill:**

- Selling display/video inventory → `skills/build-seller-agent/`
- Serving audience segments → `skills/build-signals-agent/`
- Managing creatives → `skills/build-creative-agent/`
- Brand identity + rights licensing → `skills/build-brand-rights-agent/`

## Specialism (or rather, protocol)

SI is a **protocol** in AdCP 3.0, not a specialism. The agent declares it via the `sponsoredIntelligence` field on the v6 `DecisioningPlatform` — the framework auto-derives `'sponsored_intelligence'` into `supported_protocols` from the four registered SI tools. There's no `specialisms: ['sponsored-intelligence']` claim today (tracked at adcontextprotocol/adcp#3961 for 3.1; when it lands, `capabilities.specialisms` becomes additive — adopters claim either form, dispatch keeps working).

Storyboard: `si_baseline` at `compliance/cache/latest/protocols/sponsored-intelligence/index.yaml`. Three phases (capability_discovery, offering_discovery, session_lifecycle) covering all four tools. The reference adapter at `examples/hello_si_adapter_brand.ts` reports **3/3 scenarios pass**.

## Protocol-Wide Requirements

Full treatment in `skills/build-seller-agent/SKILL.md` §Protocol-Wide Requirements. Minimum viable pointers for an SI agent:

- **`idempotency_key`** required on every mutating request — `si_initiate_session` and `si_send_message`. `si_terminate_session` is naturally idempotent on `session_id` and intentionally lacks the key (re-terminating a closed session must return the same payload). `si_get_offering` is read-only.
- **Authentication** via `serve({ authenticate })` with `verifyApiKey` / `verifyBearer`. Unauthenticated agents fail the universal `security_baseline` storyboard.
- **Signature-header transparency**: accept requests with `Signature-Input` / `Signature` headers even if you don't claim `signed-requests`.

## Before Writing Code

### 1. What brand?

SI agents are typically **single-brand per deployment** — one Agentforce instance per advertiser, one OpenAI Assistant per brand, one in-house service per product line. Multi-brand variants exist (one customer fronting many brands) but route via per-API-key tenant binding inside `accounts.resolve`, not by carrying `account` on the wire (the SI tool schemas don't have it).

Decide: how many brands does this agent serve, and how does each request bind to one?

### 2. Where does session state live?

The framework auto-hydrates a small `req.session` record (intent, offering scoping, identity consent, negotiated capabilities) onto `si_send_message` / `si_terminate_session` calls — fine for the fixture / mock case and the "what was the original scope?" lookup. **Production brand engines almost always own full transcript state in their own backend** (Postgres, Redis, vector store) — full transcripts, RAG embeddings, tool-call logs are too rich for `ctx_metadata` and easily exceed the 16KB blob cap. Treat `req.session` as a convenience, not authoritative state.

### 3. What offerings?

Each offering represents a sponsored experience the brand hosts:

- **Product/brand being sponsored** (`Volta EV`, `Trail Runner Summer Collection`)
- **Conversation style** — informational, promotional, interactive
- **Supported modalities** — text-only, voice, video, A2UI surfaces
- **Lifetime** — a TTL on the `offering_token`

### 4. Handoff modes?

`si_terminate_session` carries a `reason` field. Two of the values trigger ACP checkout:

- `handoff_transaction` — return `acp_handoff` with `checkout_url`, `checkout_token`, `expires_at`
- `handoff_complete` — conversation concluded naturally; no checkout

Other values (`user_exit`, `session_timeout`, `host_terminated`) are operational. Decide which transactional flows your brand supports — at minimum, `handoff_complete` is universal.

## Tools and Required Response Shapes

> **Before writing any handler's return statement, fetch [`docs/llms.txt`](../../docs/llms.txt) and grep for `#### \`<tool_name>\``** (e.g. `#### \`si_initiate_session\``) to read the exact required + optional field list. The schema-derived contract lives there; this skill covers patterns, gotchas, and SI-specific examples. Strict response validation is on by default in dev — it will tell you the exact field path if you drift.
>
> **Cross-cutting pitfalls SI compliance keeps catching:**
>
> - **Field name is `session_status`, not `status`.** `'active' | 'pending_handoff' | 'complete' | 'terminated'`. `status: 'active'` fails wire validation with `/session_status: must be one of...`.
> - **Termination uses boolean `terminated: true`**, not `status: 'terminated'`.
> - **`si_send_message` response — `session_id` is required**, even though it's also in the request. Echo it from `req.session_id`.
> - **`si_get_offering` — `available: boolean` is required** at the top level even when nothing else is.
> - **`reason` enum on `si_terminate_session` is closed** — `user_exit | session_timeout | host_terminated | handoff_transaction | handoff_complete`. Anything else fails wire validation.
> - **`product_card` in `ui_elements` requires `data.title` + `data.price`.** Upstream brand-platform vocabulary often uses `name` + `display_price`; project per-`type` (the example does this in `projectComponent`). Same gotcha for `action_button` → requires `data.label` + `data.action`.

**Handler bindings — read the Contract column entry before writing each return:**

| Tool                    | Handler                                  | Contract                                                                | Gotchas                                                                                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_adcp_capabilities` | auto-generated                           | n/a                                                                     | Do not register manually. Framework adds `'sponsored_intelligence'` to `supported_protocols` when `platform.sponsoredIntelligence` is present.                                                                                                                       |
| `si_get_offering`       | `sponsoredIntelligence.getOffering`      | [`#si_get_offering`](../../docs/llms.txt#si_get_offering)               | Mint an `offering_token` so the brand can recall the products-shown record on the next `initiateSession` (resolves "the second one" without replaying the transcript). Top-level requires `available: boolean`. Offering details nest under `offering`.              |
| `si_initiate_session`   | `sponsoredIntelligence.initiateSession`  | [`#si_initiate_session`](../../docs/llms.txt#si_initiate_session)       | Returns `session_id` + initial assistant turn. Framework auto-stores a small session record (intent, offering scoping, identity, negotiated capabilities, ttl) under `ResourceKind: 'si_session'`. Required `idempotency_key` — replays must return the same response. |
| `si_send_message`       | `sponsoredIntelligence.sendMessage`      | [`#si_send_message`](../../docs/llms.txt#si_send_message)               | Auto-hydrated `req.session` from the stored record. `idempotency_key` required — each turn is a transcript mutation. Surface `pending_handoff` + populated `handoff` block to signal the host to call terminate.                                                     |
| `si_terminate_session`  | `sponsoredIntelligence.terminateSession` | [`#si_terminate_session`](../../docs/llms.txt#si_terminate_session)     | Naturally idempotent on `session_id`; framework stores the `acp_handoff` payload so re-terminate replays return the same result. No `idempotency_key`.                                                                                                                |

### Context and Ext Passthrough

The framework auto-echoes the request's `context` into every response from typed sub-platform handlers — **do not set `context` yourself in your handler return values.** It's injected post-handler only when the field isn't already present.

**SI override.** `si_get_offering` and `si_initiate_session` allow `intent` as a top-level natural-language string (per spec: _'mens size 14 near Cincinnati'_). The response schema still keeps `context` as the protocol echo object — the framework auto-echoes object-typed `context` and skips non-object intent strings. If you want correlation tracking, populate `context: { correlation_id, ... }` in the request envelope and the framework round-trips it.

`si_send_message` and `si_terminate_session` use the standard protocol echo on both sides — leave `context` out of your handler return.

## SDK Quick Reference

| SDK piece                                                                          | Usage                                                                                                                                              |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAdcpServerFromPlatform(platform, opts)`                                     | Create server from a typed `DecisioningPlatform` — compile-time enforcement, auto-derived capabilities                                              |
| `definePlatform<TConfig, TCtxMeta>({ capabilities, accounts, sponsoredIntelligence })` | Type-level identity helper for the platform object literal                                                                                     |
| `defineSponsoredIntelligencePlatform<TCtxMeta>({ getOffering, initiateSession, sendMessage, terminateSession })` | Type-level identity for the `SponsoredIntelligencePlatform` sub-object                                                                              |
| `serve(() => createAdcpServerFromPlatform(platform, opts))`                        | Start HTTP server on `:3001/mcp`                                                                                                                   |
| `req.session` _(on `sendMessage` / `terminateSession`)_                            | Auto-hydrated session record — intent, offering scoping, identity, negotiated capabilities, ttl. Fixture-grade; production owns full state in its own backend. |
| `ctx.store`                                                                        | Adopter-managed state. Use for full transcripts, RAG embeddings — anything past the 16KB blob cap on auto-hydration.                               |
| `adcpError(code, { message })`                                                     | Structured error                                                                                                                                   |

Handlers return raw data objects. The framework auto-wraps responses, auto-generates `get_adcp_capabilities` from registered handlers, and emits `'sponsored_intelligence'` in `supported_protocols` when the platform field is present.

Import: `import { createAdcpServerFromPlatform, definePlatform, defineSponsoredIntelligencePlatform, serve, adcpError } from '@adcp/sdk/server';`

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

The reference adapter at [`examples/hello_si_adapter_brand.ts`](../../examples/hello_si_adapter_brand.ts) is the worked starting point. Fork it, replace `// SWAP:` markers with calls to your real backend.

Skeleton:

```typescript
import { randomUUID } from 'node:crypto';
import {
  createAdcpServerFromPlatform,
  definePlatform,
  defineSponsoredIntelligencePlatform,
  serve,
  verifyApiKey,
  createIdempotencyStore,
  memoryBackend,
  adcpError,
  type AccountStore,
} from '@adcp/sdk/server';

interface BrandMeta {
  brand_id: string;
  [key: string]: unknown;
}

const accounts: AccountStore<BrandMeta> = {
  resolve: async ref => {
    // SI tool schemas don't carry `account` on the wire — `resolve(undefined)`
    // fires on every request. Fall back to the per-tenant brand binding from
    // your auth layer (ctx.authInfo) here. Single-brand deployments hardcode.
    return {
      id: 'brand_volta',
      name: 'Nova Motors',
      status: 'active',
      ctx_metadata: { brand_id: 'brand_volta' },
    };
  },
};

const sponsoredIntelligence = defineSponsoredIntelligencePlatform<BrandMeta>({
  getOffering: async (req, ctx) => {
    // SWAP: look up offering in your CMS / catalog. Mint an offering_token
    // so initiateSession can recall what products were shown.
    return {
      available: true,
      offering_token: `oqt_${randomUUID()}`,
      ttl_seconds: 900,
      offering: {
        offering_id: req.offering_id,
        title: 'Volta EV — Conversational Concierge',
        summary: 'Talk to the Volta product team about range, charging, and lease vs. buy.',
        landing_url: 'https://novamotors.example/volta',
      },
    };
  },

  initiateSession: async (req, ctx) => {
    // SWAP: spin up your brand-engine session. session_id MUST be high-entropy
    // (≥122 bits) — a guessable id lets one buyer impersonate another's
    // session. The framework auto-stores intent / offering / identity onto
    // req.session for subsequent calls.
    const sessionId = `sess_${randomUUID()}`;
    // SWAP: persist your full session state (transcript, RAG context, etc.)
    // in your own backend keyed by sessionId. ctx.store is for the small
    // auto-hydrated record only.
    return {
      session_id: sessionId,
      session_status: 'active' as const,
      session_ttl_seconds: 1200,
      response: {
        message: 'Hi from Volta. What are you curious about — range, charging, or pricing?',
      },
    };
  },

  sendMessage: async (req, ctx) => {
    // req.session is auto-hydrated with the original intent / offering scope.
    // SWAP: load the full transcript from your own backend, append the new turn,
    // run your brand-aware LLM, write back, return the assistant response.
    return {
      session_id: req.session_id,
      session_status: 'active' as const,
      response: {
        message: 'The Volta Long Range goes 320 miles on a full charge.',
        ui_elements: [
          {
            type: 'product_card',
            data: {
              title: 'Volta EV Long Range AWD',
              price: '$48,900',
              image_url: 'https://test-assets.adcontextprotocol.org/nova-motors/volta-long-range.jpg',
            },
          },
        ],
      },
    };
  },

  terminateSession: async (req, ctx) => {
    // SWAP: close your session, finalize transcripts, mint ACP checkout token
    // if reason is handoff_transaction. The framework auto-stores acp_handoff
    // onto the session record so re-terminate replays return the same payload.
    return {
      session_id: req.session_id,
      terminated: true,
      session_status: 'terminated' as const,
      ...(req.reason === 'handoff_transaction'
        ? {
            acp_handoff: {
              checkout_url: `https://novamotors.example/checkout?conv=${req.session_id}`,
              checkout_token: `acp_tok_${randomUUID()}`,
              expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            },
          }
        : {}),
    };
  },
});

const platform = definePlatform<Record<string, never>, BrandMeta>({
  // SI is a protocol, not a specialism (adcp#3961). The platform field's
  // presence is the declaration; framework auto-derives 'sponsored_intelligence'
  // into supported_protocols from the four SI tools getting registered.
  capabilities: { specialisms: [] as const, config: {} },
  accounts,
  sponsoredIntelligence,
});

const idempotency = createIdempotencyStore({
  backend: memoryBackend(),
  ttlSeconds: 86_400,
});

serve(
  ({ taskStore }) =>
    createAdcpServerFromPlatform(platform, {
      name: 'My SI Agent',
      version: '1.0.0',
      taskStore,
      idempotency,
    }),
  {
    authenticate: verifyApiKey({
      verify: async token => {
        const row = await db.api_keys.findUnique({ where: { token } });
        return row ? { principal: row.account_id } : null;
      },
    }),
  }
);
```

## Idempotency

AdCP v3 requires `idempotency_key` on every mutating request. For SI: `si_initiate_session` and `si_send_message`. `si_terminate_session` is exempt (naturally idempotent via `session_id`). `si_get_offering` is read-only.

What the framework handles when you pass `idempotency: createIdempotencyStore(...)`:

- Rejects missing or malformed `idempotency_key` with `INVALID_REQUEST`. Spec pattern is `^[A-Za-z0-9_.:-]{16,255}$` — short test keys like `"key1"` fail length, not idempotency logic.
- **`si_send_message` is auto-scoped by `session_id`** in addition to the principal. Same key under two sessions does not cross-replay.
- JCS-canonicalized payload hashing; `IDEMPOTENCY_CONFLICT` on same-key-different-payload (no payload leak — error body is code + message only).
- `IDEMPOTENCY_EXPIRED` past the TTL (±60s clock-skew tolerance).
- `replayed: true` on `result.structuredContent.replayed` for cache hits.
- Auto-declares `adcp.idempotency.replay_ttl_seconds` on `get_adcp_capabilities`.
- Only successful responses cache — a failed generation re-executes on retry so buyers can safely retry transient errors without burning the key.

`ttlSeconds` must be in `[3600, 604800]` — out of range throws at construction.

## Protecting your agent

**An AdCP agent that accepts unauthenticated requests is non-compliant** (see `security_baseline` in the universal storyboard bundle). Wire one of these into `serve()`:

```typescript
import { serve, verifyApiKey, verifyBearer, anyOf } from '@adcp/sdk/server';

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
  publicUrl: AGENT_URL,
  authenticate: verifyBearer({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    issuer: 'https://auth.example.com',
    audience: AGENT_URL, // MUST equal publicUrl
  }),
  protectedResource: { authorization_servers: ['https://auth.example.com'] },
});
```

The framework produces RFC 6750-compliant `WWW-Authenticate: Bearer` 401s on failure, and serves `/.well-known/oauth-protected-resource<mountPath>` with `publicUrl` as the `resource` field. Default JWT allowlist is asymmetric-only (RS\*/ES\*/PS\*/EdDSA) to prevent algorithm-confusion attacks.

## Validate Locally

**Full validation checklist:** [docs/guides/VALIDATE-YOUR-AGENT.md](../../docs/guides/VALIDATE-YOUR-AGENT.md). SI-specific commands:

```bash
# Boot
npx tsx agent.ts &

# Happy path — full session lifecycle (3 phases, all 4 SI tools)
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp si_baseline --auth $TOKEN

# Cross-cutting obligations
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp \
  --storyboards security_baseline,idempotency,schema_validation,error_compliance --auth $TOKEN

# Rejection-surface fuzz
npx @adcp/sdk@latest fuzz http://localhost:3001/mcp \
  --tools si_get_offering,si_initiate_session --auth-token $TOKEN
```

**Reference target**: `npx @adcp/sdk@latest mock-server sponsored-intelligence` boots a brand-agent fixture you can wrap end-to-end. The reference adapter at [`examples/hello_si_adapter_brand.ts`](../../examples/hello_si_adapter_brand.ts) reports `3/3 scenarios pass` against `si_baseline`.

Common failure decoder:

- `status` field on session response → rename to `session_status` (canonical field name).
- `status: 'terminated'` on terminate response → use boolean `terminated: true`.
- Missing `session_id` on `si_send_message` response → echo from request, required.
- Missing `available` boolean on `si_get_offering` → required even for mock data.
- `reason` outside the closed enum on `si_terminate_session` → must be `user_exit | session_timeout | host_terminated | handoff_transaction | handoff_complete`.
- `product_card.data` missing `title` or `price` → schema requires both; project per-`type` from your upstream component vocabulary.

**Keep iterating until all steps pass.** Can't bind ports? `npm run compliance:skill-matrix -- --filter si` runs an isolated end-to-end test.

## Common Mistakes

| Mistake                                                      | Fix                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manually registering `get_adcp_capabilities`                 | Framework auto-generates from registered handlers — do not register it yourself.                                                                                                                                                                                                               |
| Declaring `specialisms: ['sponsored-intelligence']`          | Not yet in `AdCPSpecialism` (adcp#3961). Use `specialisms: [] as const` and let the platform field's presence drive `supported_protocols`. When 3.1 lands, declaring the specialism becomes additive — both forms work.                                                                          |
| Routing through the v5 `createAdcpServer` handler-bag        | The v6 path lands in 6.7. Use `createAdcpServerFromPlatform` + `defineSponsoredIntelligencePlatform`. v5 still works for in-flight migrations but lacks auto-hydrated `req.session`.                                                                                                          |
| Modeling full transcripts in `ctx_metadata`                  | The auto-hydrated `req.session` is for the small lookup-the-original-scope case. Production keeps full transcripts (RAG embeddings, tool-call logs) in your own Postgres / Redis / vector store keyed by `req.session_id`. The 16KB blob cap will bite if you try to use ctx_metadata.        |
| Returns `status` instead of `session_status`                 | Field name is `session_status` — `status` will fail schema validation.                                                                                                                                                                                                                          |
| Returns `status: 'terminated'` instead of `terminated: true` | Termination response uses boolean `terminated`.                                                                                                                                                                                                                                                  |
| Missing `session_id` in `si_send_message` response           | Echo `session_id` back from request — required.                                                                                                                                                                                                                                                  |
| Missing `available` in `si_get_offering`                     | Boolean `available` is required at the top level — even for mock data.                                                                                                                                                                                                                          |
| `product_card` missing `title` + `price`                     | AdCP `SIUIElement.product_card` requires `data.title` + `data.price`. Upstream brand-platform vocabulary often uses `name` + `display_price` — project per-`type` (the example does this in `projectComponent`). Same for `action_button` (`label` + `action`).                                |
| Hand-set `context` on response                               | Let the framework echo the protocol context object. Don't set a string or your own object — only the protocol-shape `context` is auto-echoed; mismatched shapes are dropped.                                                                                                                     |

## Storyboards

| Storyboard    | Tests                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| `si_baseline` | Full session lifecycle: capability discovery → offering discovery → session lifecycle. |

## Reference

- [`examples/hello_si_adapter_brand.ts`](../../examples/hello_si_adapter_brand.ts) — worked SI adapter wrapping the SI mock server.
- `compliance/cache/latest/protocols/sponsored-intelligence/index.yaml` — `si_baseline` storyboard spec.
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns.
- `docs/TYPE-SUMMARY.md` — curated type signatures.
- `docs/llms.txt` — full protocol reference (search `#### \`si_initiate_session\`` etc. for tool-specific contracts).

## Tracking

- adcontextprotocol/adcp#3961 — SI in `AdCPSpecialism` for 3.1. Once landed, this skill's `specialisms: []` becomes `specialisms: ['sponsored-intelligence'] as const`.
- adcontextprotocol/adcp#3981 — `si_baseline` storyboard `context_outputs` capture-path bug (top-level `offering_id` mirror in the example is a workaround until this lands).
