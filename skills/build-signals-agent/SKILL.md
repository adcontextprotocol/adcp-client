---
name: build-signals-agent
description: Use when building an AdCP signals agent, creating an audience data server, or standing up a data provider agent that serves targeting segments to buyers.
---

# Build a Signals Agent

## Overview

A signals agent serves audience segments to buyers for campaign targeting. Two tools: `get_signals` (discovery) and `activate_signal` (push to DSPs or sales agents). The business model — marketplace vs owned data — shapes every implementation decision. Determine that first.

## When to Use

- User wants to build an agent that serves audience/targeting data
- User mentions signals, segments, audiences, data provider, or CDP in the context of AdCP
- User references `get_signals`, `activate_signal`, or the signals protocol

**Not this skill:**

- Selling ad inventory (products, packages, media buys) → `skills/build-seller-agent/`
- Rendering creatives from briefs → that's a creative agent
- Building a client that _calls_ a signals agent → see `docs/getting-started.md`

## Specialisms This Skill Covers

| Specialism           | Status | Delta                                                                                                                                                               | See                                                    |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `signal-marketplace` | stable | `signal_id.source: 'catalog'` + resolvable `data_provider_domain`; span ≥2 providers in demos; platform activations are **async** (`is_live: false` → poll to live) | [§ signal-marketplace](#specialism-signal-marketplace) |
| `signal-owned`       | stable | `signal_id.source: 'agent'` + your `agent_url`; `value_type` constraints (`allowed_values` for categorical, `min`/`max` for numeric); `deployed_at` on deployments  | [§ signal-owned](#specialism-signal-owned)             |

## Protocol-Wide Requirements

Full treatment lives in `skills/build-seller-agent/SKILL.md` §Protocol-Wide Requirements and §Composing. Minimum viable pointers for a signals agent:

- **`idempotency_key`** on every mutating request (`activate_signal`, and any future mutating signals tools). Wire `createIdempotencyStore` into `createAdcpServer({ idempotency })`.
- **Authentication** via `serve({ authenticate })` with `verifyApiKey`/`verifyBearer` from `@adcp/sdk/server`. Unauthenticated agents fail the universal `security_baseline` storyboard.
- **Signature-header transparency**: accept requests with `Signature-Input`/`Signature` headers even if you don't claim `signed-requests`.

## Before Writing Code

Determine these four things. Ask the user — don't guess.

### 1. Marketplace or Owned?

These are fundamentally different businesses.

**Marketplace** — aggregates third-party data providers (LiveRamp, Oracle Data Cloud, Lotame). Each signal traces to a `data_provider_domain` that buyers can verify via `adagents.json`. `signal_type: "marketplace"`, `signal_id.source: "catalog"`.

**Owned** — first-party data (retailer CDP, publisher contextual, CRM). Buyers trust your agent directly. `signal_type: "owned"` or `"custom"`, `signal_id.source: "agent"`.

### 2. What Segments?

Get specifics: names, definitions, what each represents. Push for 3-5 segments with variety. Each needs:

- Clear behavioral/demographic definition
- Realistic `coverage_percentage` (typically 5-30%)
- Value type: `binary` (in/out), `categorical` (tier levels — define the categories), or `numeric` (score range — define min/max)

### 3. Pricing

At least one pricing option per signal. Signals use `VendorPricingOption` (field: `model`), distinct from product `PricingOption` (field: `pricing_model`).

- `cpm` — `{ pricing_option_id: "po_cpm", model: "cpm", cpm: 2.50, currency: "USD" }`
- `percent_of_media` — `{ pricing_option_id: "po_pom", model: "percent_of_media", percent: 15, currency: "USD" }`
- `flat_fee` — `{ pricing_option_id: "po_flat", model: "flat_fee", amount: 5000, period: "monthly", currency: "USD" }`

### 4. Activation Destinations

If implementing `activate_signal`:

- **Platform** (DSP): `type: "platform"`, returns `activation_key: { type: "segment_id", segment_id: "..." }`
- **Agent** (sales agent): `type: "agent"`, returns `activation_key: { type: "key_value", key: "...", value: "..." }`

## Tools and Required Response Shapes

> **Before writing any handler's return statement, fetch [`docs/llms.txt`](../../docs/llms.txt) and grep for `#### \`<tool_name>\``(e.g.`#### \`get_signals\``) to read the exact required + optional field list.** The schema-derived contract lives there; this skill covers patterns, gotchas, and domain-specific examples. Strict response validation is on by default in dev — it will tell you the exact field path if you drift, so write the obvious thing and trust the contract.
>
> **Cross-cutting pitfalls matrix runs keep catching:**
>
> - **Declare `capabilities: { specialisms: ['signal-marketplace'] }` (or `'signal-owned'`) on `createAdcpServer`.** Value is `string[]` of enum ids (not `[{id, version}]`). Agents that don't declare their specialism fail the grader with "No applicable tracks found" even if every tool works — tracks are gated on the specialism claim.

**`get_adcp_capabilities`** — auto-generated by `createAdcpServer` from registered handlers. Do not register manually.

**`get_signals`** — handled by `signals.getSignals`

Two discovery modes — support both:

1. `signal_spec` — natural language. Match against segment names and descriptions.
2. `signal_ids` — exact lookup by `{ source, data_provider_domain, id }` or `{ source, agent_url, id }`.

Plus filtering via `filters.catalog_types`, `filters.max_cpm`, `filters.min_coverage_percentage`, and `max_results`.

```
getSignalsResponse({
  signals: [{
    signal_agent_segment_id: string,  // required - key for activate_signal
    name: string,                     // required
    description: string,              // required
    signal_type: 'marketplace' | 'owned' | 'custom',  // required
    data_provider: string,            // required - your company name
    coverage_percentage: number,      // required - 0 to 100
    deployments: [],                  // required - empty array (not live until activated)
    pricing_options: [{               // required - at least one
      pricing_option_id: string,      // required
      model: 'cpm',                   // required - discriminator
      cpm: number,                    // required for cpm model
      currency: 'USD',               // required
    }],
    // signal_id is critical — shape depends on marketplace vs owned:
    signal_id: {
      source: 'catalog',             // marketplace
      data_provider_domain: string,  // marketplace — domain for provenance verification
      id: string,                    // unique segment ID
    },
    // OR for owned:
    signal_id: {
      source: 'agent',              // owned
      agent_url: string,            // your agent URL
      id: string,
    },
    value_type: 'binary' | 'categorical' | 'numeric',  // optional but recommended
  }],
  sandbox: true,  // for mock data
})
```

**`activate_signal`** — handled by `signals.activateSignal`

Look up by `signal_agent_segment_id`. Validate `pricing_option_id`. Return deployments matching the requested destinations. **Platform activation is async; agent activation is sync** — different shape per destination type, driven by the compliance contract:

```
activateSignalResponse({
  deployments: [
    // Platform (DSP) — ASYNC. First response returns is_live:false plus
    // an ETA AND the planned activation_key. Buyer re-sends activate_signal
    // to poll until is_live:true; final response adds deployed_at.
    {
      type: 'platform',
      platform: string,
      account: string | null,                              // echo from request
      is_live: false,                                      // flips true on completion
      estimated_activation_duration_minutes: number,       // present while activating
      activation_key: { type: 'segment_id', segment_id: string },  // committed up front
      deployed_at: string,                                 // ISO; present when is_live:true
    },
    // Agent (sales-agent) — SYNC. First response is the final response.
    {
      type: 'agent',
      agent_url: string,
      is_live: true,
      activation_key: { type: 'key_value', key: string, value: string },
      deployed_at: string,                                 // ISO timestamp
    },
  ],
  sandbox: true,
})
```

### Context and Ext Passthrough

`createAdcpServer` auto-echoes the request's `context` into every response — **do not set `context` yourself in your handler return values.** The framework injects it post-handler only when the field isn't already present.

**Crucial:** `context` is schema-typed as an object. If your handler hand-sets a string or narrative description, validation fails with `/context: must be object` and the framework does not overwrite. Leave the field out entirely; the framework handles it.

Some schemas also define an `ext` field for vendor-namespaced extensions. If your request schema includes `ext`, accept it without error. Tools with explicit `ext` support: `activate_signal`.

## SDK Quick Reference

| SDK piece                                             | Usage                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `createAdcpServer(config)`                            | Create server with domain-grouped handlers and auto-capabilities               |
| `serve(() => createAdcpServer(config))`               | Start HTTP server on `:3001/mcp`                                               |
| `signals: { getSignals, activateSignal }`             | Domain group — register handlers by name                                       |
| `ctx.store.put(collection, id, data)`                 | Persist state (activations, segment cache) across requests                     |
| `ctx.store.get(collection, id)`                       | Retrieve persisted state                                                       |
| `getSignalsResponse(data)`                            | Auto-applied response builder (don't call manually)                            |
| `activateSignalResponse(data)`                        | Auto-applied response builder (don't call manually)                            |
| `adcpError(code, { message })`                        | Structured error (`SIGNAL_NOT_FOUND`, `INVALID_DESTINATION`)                   |
| `createIdempotencyStore({ backend, ttlSeconds })`     | Required on every mutating tool — pass via `createAdcpServer({ idempotency })` |
| `memoryBackend()` / `pgBackend(pool)`                 | Idempotency backends (from `@adcp/sdk/server`)                              |
| `type Signal = GetSignalsResponse['signals'][number]` | Type for a single signal object                                                |

Import: `import { createAdcpServer, serve, adcpError } from '@adcp/sdk';`
Server-only: `import { createIdempotencyStore, memoryBackend } from '@adcp/sdk/server';`
Types: `import type { GetSignalsResponse } from '@adcp/sdk';`

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

1. Single `.ts` file — all tools in one file
2. Use `createAdcpServer` with a `signals` domain group — `get_adcp_capabilities` is auto-generated
3. Handlers return raw data objects — response builders (`getSignalsResponse`, `activateSignalResponse`) are auto-applied
4. Use `ctx.store` for persisting signal activations across requests (InMemoryStateStore by default)
5. Set `sandbox: true` for mock/demo data
6. Context passthrough is handled by the framework — no need to manually echo `args.context`

```typescript
import { createAdcpServer, serve, adcpError } from '@adcp/sdk';
import { createIdempotencyStore, memoryBackend } from '@adcp/sdk/server';

const signals = [
  /* your signal objects */
];

// Idempotency — required for v3 compliance. `activate_signal` is mutating;
// `get_signals` is read-only and exempt from key validation.
const idempotency = createIdempotencyStore({
  backend: memoryBackend(), // pgBackend(pool) for production
  ttlSeconds: 86400, // 24 hours (spec bounds: 1h–7d)
});

serve(() =>
  createAdcpServer({
    name: 'My Signals Agent',
    version: '1.0.0',
    idempotency,

    // Principal scoping for idempotency. MUST never return undefined — or
    // every mutating request rejects as SERVICE_UNAVAILABLE. A constant
    // works for a demo; for multi-tenant use ctx.account.
    resolveSessionKey: () => 'default-principal',

    signals: {
      getSignals: async (params, ctx) => {
        let results = signals;
        if (params.signal_spec) {
          const query = params.signal_spec.toLowerCase();
          results = results.filter(
            s => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query)
          );
        }
        if (params.signal_ids) {
          results = results.filter(s => params.signal_ids!.some(id => id.id === s.signal_id.id));
        }
        return { signals: results, sandbox: true };
      },

      activateSignal: async (params, ctx) => {
        const signal = signals.find(s => s.signal_agent_segment_id === params.signal_agent_segment_id);
        // Return the error — the framework echoes returned adcpError
        // responses verbatim. Thrown errors are caught and converted to
        // SERVICE_UNAVAILABLE, which hides your custom code from the buyer.
        if (!signal)
          return adcpError('SIGNAL_NOT_FOUND', { message: `Unknown segment: ${params.signal_agent_segment_id}` });

        // Persist activation in state store
        await ctx.store.put('activations', params.signal_agent_segment_id, {
          signal_agent_segment_id: params.signal_agent_segment_id,
          destinations: params.destinations,
          activated_at: new Date().toISOString(),
        });

        // Platform (DSP) activation is ASYNC per spec — return `is_live: false`
        // with `estimated_activation_duration_minutes`. The buyer polls
        // (a subsequent `activate_signal` with the same destinations, or a
        // provider-specific status tool) until `is_live: true`.
        //
        // Agent (sales-agent) activation is SYNC — return `is_live: true` with
        // `activation_key.type: 'key_value'` and a `deployed_at` timestamp.
        //
        // Both shapes include `activation_key` so the buyer knows how to
        // reference the segment when building media buys through the DSP or SA.
        const deployments = params.destinations.map(dest => {
          if (dest.type === 'platform') {
            return {
              type: 'platform' as const,
              platform: dest.platform,
              is_live: false,
              estimated_activation_duration_minutes: 30,
              // Return activation_key even while is_live is false — the
              // buyer needs to know the planned segment_id now so it can
              // reference it in downstream media buys. `is_live` just
              // flags whether the DSP has confirmed provisioning;
              // `activation_key` is the agent's commitment.
              activation_key: {
                type: 'segment_id' as const,
                segment_id: `${dest.platform}_${signal.signal_id.id}`,
              },
            };
          }
          return {
            type: 'agent' as const,
            agent_url: dest.agent_url,
            is_live: true,
            activation_key: { type: 'key_value' as const, key: 'audience', value: signal.signal_id.id },
            deployed_at: new Date().toISOString(),
          };
        });
        return { deployments, sandbox: true };
      },
    },
  })
);
```

## Idempotency

AdCP v3 requires an `idempotency_key` on every mutating request — for signals agents that's `activate_signal` only (`get_signals` is read-only and exempt). Idempotency is already wired in the Implementation example above. The framework then handles:

- Missing/malformed key → `INVALID_REQUEST` (spec pattern `^[A-Za-z0-9_.:-]{16,255}$`)
- JCS-canonicalized payload hashing with same-key-different-payload → `IDEMPOTENCY_CONFLICT` (no payload leaked in the error body)
- Past-TTL replay → `IDEMPOTENCY_EXPIRED` (±60s clock-skew tolerance)
- Cache hits replay the cached envelope with `replayed: true` injected
- `adcp.idempotency.replay_ttl_seconds` auto-declared on `get_adcp_capabilities`
- Only successful responses cache — a failed activation re-executes on retry
- Atomic claim so concurrent retries with a fresh key don't all race to activate

Scoping is per-principal via `resolveSessionKey` (override with `resolveIdempotencyPrincipal` for custom scoping). `ttlSeconds` must be 3600–604800 — out of range throws at construction. If you register mutating handlers without wiring `idempotency`, the framework logs an error at server-creation time.

**Critical: probe the pool at boot (pgBackend).** `pg.Pool` is lazy — `new Pool({ connectionString })` does not validate the URL. A bad `DATABASE_URL` lets the server start, advertise `IdempotencySupported`, and then silently fail every `activate_signal` call. Wire `readinessCheck` on `serve()` so the server never accepts traffic with a broken pool:

```ts
const store = createIdempotencyStore({ backend: pgBackend(pool), ttlSeconds: 86400 });
pool.on('error', (err) => console.error('pg pool error', err)); // prevent crash on idle-client errors
serve(createAgent, {
  readinessCheck: () => store.probe(), // throws with a descriptive error if pool/table is broken
});
```

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

**Full validation checklist:** [docs/guides/VALIDATE-YOUR-AGENT.md](../../docs/guides/VALIDATE-YOUR-AGENT.md). Signals-specific commands:

```bash
# Boot
npx tsx agent.ts &

# Happy path — the specialism you're claiming
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp signal_owned --auth $TOKEN        # owned data
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp signal_marketplace --auth $TOKEN  # marketplace

# Marketplace governance sub-scenario (if you claim signal_marketplace)
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp signal_marketplace/governance_denied --auth $TOKEN

# Cross-cutting obligations
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp \
  --storyboards security_baseline,idempotency,schema_validation,error_compliance --auth $TOKEN

# Rejection-surface fuzz
npx @adcp/sdk@latest fuzz http://localhost:3001/mcp --tools get_signals --auth-token $TOKEN
```

Common failure decoder:

- `value_type` mismatch → `binary` vs. `continuous` — pick one; continuous signals return `value`, binary signals return membership
- Missing `deployments` on signal → required even if empty `[]`
- `activate_signal` returns sync success on a marketplace signal → marketplace activations are async; commit to an `activation_key` up-front and return `submitted`
- Missing `coverage_percentage` or `pricing_options` → required on every signal

**Keep iterating until all steps pass.** Can't bind ports? `npm run compliance:skill-matrix -- --filter signals` runs an isolated end-to-end test.

## Common Mistakes

| Mistake                                           | Fix                                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Using `createTaskCapableServer` + `server.tool()` | Use `createAdcpServer` with `signals` domain group                                                          |
| Using module-level Maps for state                 | Use `ctx.store.put/get` — framework provides `InMemoryStateStore` by default                                |
| Manually registering `get_adcp_capabilities`      | Auto-generated by `createAdcpServer` from registered handlers                                               |
| Calling response builders manually                | Handlers return raw data — `getSignalsResponse`/`activateSignalResponse` are auto-applied                   |
| Missing `signal_agent_segment_id` on signals      | Buyers can't activate without it                                                                            |
| Wrong `signal_id` shape                           | Marketplace: `{ source: "catalog", data_provider_domain, id }`. Owned: `{ source: "agent", agent_url, id }` |
| Missing `data_provider` field                     | Required on every signal — your company/brand name                                                          |
| Empty `pricing_options` array                     | Must have at least one pricing option per signal                                                            |
| `is_live: true` in get_signals deployments        | Signals aren't live until `activate_signal` — use empty `deployments: []`                                   |
| Activation doesn't match destination type         | If request has `type: "platform"`, deployment must be `type: "platform"`                                    |
| `sandbox: false` on mock data                     | Buyers may treat mock data as real                                                                          |

## Specialism Details

### <a name="specialism-signal-marketplace"></a>signal-marketplace

**Async platform activation.** Unlike agent activations (`type: 'agent'`), platform activations (`type: 'platform'`) are not instant — the segment takes minutes-to-hours to propagate to the DSP. Return `is_live: false` with an estimate, then the buyer polls `activate_signal` again until `is_live: true`.

```typescript
activateSignal: async (params, ctx) => {
  const signal = signals.find((s) => s.signal_agent_segment_id === params.signal_agent_segment_id);
  if (!signal) return adcpError('SIGNAL_NOT_FOUND', { message: `Unknown segment` });

  const deployments = await Promise.all(params.destinations.map(async (dest) => {
    if (dest.type === 'platform') {
      // Async — check whether this destination has already been propagated
      const existing = await ctx.store.get('deployments', `${params.signal_agent_segment_id}:${dest.platform}`);
      if (existing?.is_live) return existing;
      if (!existing) {
        const pending = {
          type: 'platform' as const,
          platform: dest.platform,
          account: dest.account ?? null,
          is_live: false,
          estimated_activation_duration_minutes: 45,
          // Commit the activation_key up front so the buyer can trust it across the poll window:
          activation_key: {
            type: 'segment_id' as const,
            segment_id: `${dest.platform}_${signal.signal_id.id}`,
          },
        };
        await ctx.store.put('deployments', `${params.signal_agent_segment_id}:${dest.platform}`, pending);
        return pending;
      }
      return existing;   // still propagating
    }
    // Agent activations are instant
    return {
      type: 'agent' as const,
      agent_url: dest.agent_url,
      is_live: true,
      deployed_at: new Date().toISOString(),
      activation_key: { type: 'key_value' as const, key: 'audience', value: signal.signal_id.id },
    };
  }));
  return { deployments, sandbox: true };
},
```

Use `forceDeploymentStatus` in your `TestControllerStore` (if you implement compliance_testing) to flip pending deployments to live for deterministic tests.

**Provenance.** `data_provider_domain` must be resolvable — buyers fetch `https://{domain}/adagents.json` out-of-band to verify the provider. Use real domains even in demos, not `example.com`. For a marketplace demo, seed ≥2 different `data_provider_domain` values so the multi-provider nature is visible.

### <a name="specialism-signal-owned"></a>signal-owned

**Value types** drive targeting semantics. The storyboard validates these fields:

```typescript
// Binary — in/out of the segment
{ value_type: 'binary' as const }

// Categorical — enumerated tier/level
{
  value_type: 'categorical' as const,
  allowed_values: ['bronze', 'silver', 'gold', 'platinum'],    // required for categorical
}

// Numeric — continuous score or count
{
  value_type: 'numeric' as const,
  min: 0,
  max: 100,
  units: 'purchase_frequency_last_90d',    // optional but recommended
}
```

`signal_type: 'custom'` is for first-party signals that don't fit the `owned` conceptual model (e.g. contextual signals derived from page content rather than user identity). Use `owned` by default; pick `custom` only when the user data model differs materially.

Platform activations are async (same pattern as marketplace). Agent activations include `deployed_at`:

```typescript
{
  type: 'agent' as const,
  agent_url: dest.agent_url,
  is_live: true,
  deployed_at: new Date().toISOString(),
  activation_key: { type: 'key_value' as const, key: 'audience', value: signal.signal_id.id },
}
```

## Reference

- `examples/signals-agent.ts` — complete runnable example
- `storyboards/signal_marketplace.yaml` — buyer call sequences for marketplace agent
- `storyboards/signal_owned.yaml` — call sequences for owned data agent
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
