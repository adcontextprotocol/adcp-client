# Migrating to `BuyerAgentRegistry` (Phase 1 of #1269)

> **Status: GA in 6.x.** Everything below is additive — adopters running
> on `@adcp/sdk` 6.x today see no behavior change unless they opt in.
> The registry surface, the kind-discriminated `credential` field on
> `ResolvedAuthInfo`, and the `sandbox_only` capability are all
> opt-in. Legacy `ResolvedAuthInfo.{token, clientId, scopes}` remain
> populated through the deprecation cycle.

## tl;dr

If you're on `@adcp/sdk` 6.x today and don't wire an `agentRegistry`, **nothing changes for you**. Skip this guide until you're ready to add buyer-agent identity to your seller.

If you want the durable identity surface — opt in via three additions:

1. Build a `BuyerAgent` record per onboarded buyer agent (in your DB or in-memory map keyed by `credential.key_id`).
2. Wrap a `BuyerAgentRegistry.signingOnly` / `bearerOnly` / `mixed` factory in `BuyerAgentRegistry.cached(...)`.
3. Set `agentRegistry` on your `DecisioningPlatform`.

The framework picks up the registry, runs `resolve()` once per request, threads the resolved record through `ctx.agent`, and gates `suspended`/`blocked` agents at 403. See [the worked reference adapter](../examples/hello_seller_adapter_signal_marketplace.ts) for the full wiring.

## What's new in Phase 1

| Feature | Purpose | Adopter-visible? |
|---|---|---|
| `BuyerAgentRegistry` Protocol + 3 factories | Map credentials to durable buyer-agent records | Opt in via `platform.agentRegistry` |
| `BuyerAgent.status` enforcement | Reject `suspended`/`blocked` agents at 403 | Active when registry returns a record |
| `ResolvedAuthInfo.credential` (kind-discriminated) | Stable identity surface across api-key / OAuth / signed-request auth | Opt in by reading `ctx.authInfo.credential.kind` |
| Verifier-attested `http_sig.agent_url` | Cryptographic proof of buyer-agent identity (per adcp#3831) | Active when `verifySignatureAsAuthenticator` is wired |
| `BuyerAgentRegistry.cached` decorator | TTL + LRU + concurrent-resolve coalescing + `invalidate()` / `clear()` API | Decorator pattern — wrap your registry |
| `BuyerAgent.sandbox_only` (Phase 1.5) | Defense-in-depth for test agents | Set on the agent record; framework gates after `accounts.resolve` |
| Credential pattern redactor | Scrub bearer tokens / labeled creds / URL basic-auth / long token-shaped strings from `error.details.reason` | Active for all 6 dispatcher error-projection sites |

## Decision tree: do I need to change anything?

| Your situation | What to do |
|---|---|
| 6.x adopter, no plans to identify buyer agents | Nothing. Continue using `ctx.authInfo.token` as before. |
| 6.x adopter using `ctx.authInfo.token` / `clientId` / `scopes` | Keep working — fields are deprecated but populated. Plan migration to `credential.kind` over the next two minors. |
| Custom `authenticate()` callback returning `{ principal, token, scopes }` | Keep working. To opt into registry routing, ALSO populate `credential` on the returned `AuthPrincipal` (kind-discriminated). |
| Adopter who wants to register buyer agents | Build the `BuyerAgentRegistry` per § "Wiring the registry" below. |
| Adopter running test/CI agents | Set `BuyerAgent.sandbox_only: true` on test agents AND have your `accounts.resolve` return `sandbox: true` on test accounts. See § "sandbox_only" below. |
| Adopter with `verifySignatureAsAuthenticator` already wired | Configure the verifier's `agentUrlForKeyid` callback. Without it, `http_sig` credentials are stamped without `agent_url`, the registry returns null on the signed path, and you fall back to bearer behavior. |

## Deprecation cycle: `ResolvedAuthInfo.{token, clientId, scopes}`

Phase 1 Stage 3 added a kind-discriminated `credential` field on `ResolvedAuthInfo` and tagged the legacy fields `@deprecated`. Two-minor cycle:

| Release | Behavior |
|---|---|
| **N (current)** | Legacy fields populated as before. New `credential?: AdcpCredential` populated by built-in authenticators. Both work simultaneously. |
| N+1 | Framework warns once per process when adopter `authenticate()` returns the legacy shape without `credential`. Runtime behavior unchanged. |
| N+2 | Legacy fields removed. Adopters MUST populate `credential` on returned `AuthPrincipal`. |

### How to migrate handler reads

```ts
// Before — legacy shape
async resolveAccount(ref, { authInfo }) {
  const clientId = authInfo?.clientId;
  // ...
}

// After — kind-discriminated
async resolveAccount(ref, { authInfo }) {
  const credential = authInfo?.credential;
  if (credential?.kind === 'oauth') {
    const clientId = credential.client_id;
    // ...
  } else if (credential?.kind === 'api_key') {
    const keyId = credential.key_id; // sha256 hash, NOT the raw token
    // ...
  } else if (credential?.kind === 'http_sig') {
    const agentUrl = credential.agent_url; // verifier-attested
    // ...
  }
}
```

### `agent_url` reads: verified vs. registry-derived

If your handler reads `agent_url` for security decisions (mutating-tool authorization, brand-side authz), read from `credential.agent_url` (only available when `credential.kind === 'http_sig'`). Verified by the framework's signature verifier per adcp#3831.

If you want the registry's view of who the agent is (display name, status, billing capabilities), read from `ctx.agent` (the resolved `BuyerAgent` record). NOT cryptographically verified — it's whatever the registry's `resolveByCredential` returned.

```ts
// Verified identity (security-relevant — http_sig only)
if (ctx.authInfo?.credential?.kind === 'http_sig') {
  const verifiedAgentUrl = ctx.authInfo.credential.agent_url;
}

// Registry identity (informational — across all credential kinds)
const buyerAgent = ctx.agent;
const displayName = buyerAgent?.display_name;
```

## Wiring the registry

### 1. Build your onboarding ledger

Production: a Postgres table keyed by `credential.key_id` (or `credential.agent_url` for signed-only deployments). The seller stores the **hash** of the api token, not the raw token — see § "Credential issuance" below.

```ts
import { createHash } from 'node:crypto';
import type { BuyerAgent } from '@adcp/sdk/server';

function hashApiKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

// Production: replace with a DB query.
const ONBOARDING_LEDGER = new Map<string, BuyerAgent>([
  [hashApiKey('sk_partner_dsp_xyz'), {
    agent_url: 'https://partner-dsp.example.com',
    display_name: 'Partner DSP',
    status: 'active',
    billing_capabilities: new Set(['operator', 'agent']),
  }],
  [hashApiKey('sk_test_harness'), {
    agent_url: 'https://addie.example.com',
    display_name: 'Test harness',
    status: 'active',
    billing_capabilities: new Set(['operator']),
    sandbox_only: true,  // see § "sandbox_only" below
  }],
]);
```

### 2. Pick a registry posture

Three factories encode the implementer posture at construction:

| Factory | When to use |
|---|---|
| `BuyerAgentRegistry.signingOnly({ resolveByAgentUrl })` | Production target. Only HTTP-Sig credentials resolve; bearer/API-key/OAuth refused at the registry layer. Cleanest long-term. |
| `BuyerAgentRegistry.bearerOnly({ resolveByCredential })` | Pre-trust beta. All credential kinds route through your mapping; signed traffic is treated the same as bearer. |
| `BuyerAgentRegistry.mixed({ resolveByAgentUrl, resolveByCredential })` | Transition. Signed credentials resolve cryptographically (preferred); bearer falls through to your legacy key table. |

```ts
import { BuyerAgentRegistry } from '@adcp/sdk/server';

const registry = BuyerAgentRegistry.cached(
  BuyerAgentRegistry.bearerOnly({
    resolveByCredential: async credential => {
      // bearerOnly receives every credential kind; MUST kind-discriminate
      // and reject anything you don't recognize.
      if (credential.kind !== 'api_key') return null;
      return ONBOARDING_LEDGER.get(credential.key_id) ?? null;
    },
  }),
  { ttlSeconds: 60 }
);
```

### 3. Wire it on your platform

```ts
class MyPlatform implements DecisioningPlatform<MyConfig, MyMeta> {
  // ... existing fields ...

  agentRegistry = registry;
}
```

That's it. The framework runs `agentRegistry.resolve(authInfo)` on every request after auth and before `accounts.resolve`. The resolved `BuyerAgent` is on `ctx.agent`; status enforcement (`suspended`/`blocked` → 403) fires automatically.

### Three implementer postures, summarized

```ts
// Production target — bearer/OAuth refused at the registry layer
BuyerAgentRegistry.signingOnly({
  resolveByAgentUrl: async (agent_url) => db.findByAgentUrl(agent_url),
});

// Pre-trust beta — all credential kinds via adopter mapping
BuyerAgentRegistry.bearerOnly({
  resolveByCredential: async (credential) => db.findByKeyId(credential),
});

// Transition (during bearer→signed migration)
BuyerAgentRegistry.mixed({
  resolveByAgentUrl: async (agent_url) => db.findByAgentUrl(agent_url),
  resolveByCredential: async (credential) => db.findByKeyId(credential),
});
```

## Credential issuance (the part the framework doesn't model)

Every seller needs an admin flow to onboard buyer agents. The framework doesn't ship one — that's adopter-side work. The contract:

1. Seller's admin UI / API generates a fresh bearer token (32+ bytes of CSPRNG entropy).
2. Compute `hashApiKey(token)` to get the `key_id` that `verifyApiKey` will stamp on every request.
3. Insert a `BuyerAgent` row into your ledger keyed by that `key_id`.
4. Hand the raw token to the buyer agent **out-of-band** (signed contract, secure delivery). The token is the credential; the ledger only stores the hash, so a leak of the ledger doesn't yield a usable credential.
5. Subsequent requests carry `Authorization: Bearer <token>`; the framework hashes, looks up the row, and threads the resolved `BuyerAgent` through `ctx.agent`.

For rotation: issue a new token with a new `key_id`, leave the old one valid for a grace window, then call `registry.invalidate(oldCredential)` and drop the old row from the ledger.

## Caching: `BuyerAgentRegistry.cached(...)`

Always wrap your registry in the cache decorator unless you have a specific reason not to. Defaults are sensible (60s TTL, 10000-entry LRU, no null caching).

```ts
const registry = BuyerAgentRegistry.cached(inner, {
  ttlSeconds: 60,           // default
  cacheNullsTtlSeconds: 0,  // default — recognize newly-onboarded agents within one request
  maxSize: 10000,           // default — bounded against credential-spam attacks
});

// Invalidate when you mutate the agent's record:
registry.invalidate(credential);

// Or clear everything (e.g., daily reset, migration):
registry.clear();
```

**Stale-status window.** TTL bounds how long a `'suspended'` or `'blocked'` flip takes to propagate. For sellers needing instant propagation, either set a short TTL or call `registry.invalidate(credential)` when you mutate the row.

**Negative cache.** Default `cacheNullsTtlSeconds: 0` means freshly-onboarded agents are recognized within one request. Enable null caching only if you understand the [timing-oracle implication](#) (an unauthenticated prober can infer "this credential was probed recently" from hit-vs-miss latency).

## `sandbox_only`: defense-in-depth for test agents

Test agents (CI runners, internal QA agents, partner pre-prod environments) shouldn't have production reach. If a test credential leaks, blast radius should be bounded to sandbox accounts.

```ts
// On the BuyerAgent record:
{
  agent_url: 'https://test-harness.example.com',
  display_name: 'CI test agent',
  status: 'active',
  billing_capabilities: new Set(['operator']),
  sandbox_only: true,  // ← the load-bearing field
}
```

**Load-bearing pair.** For a sandbox-only agent to admit ANY traffic, your `accounts.resolve` MUST return `sandbox: true` on the matching accounts. Mismatches produce `PERMISSION_DENIED + scope: 'agent' + reason: 'sandbox-only'` on every request — failure is loud, not silent.

```ts
// In accounts.resolve:
return {
  id: account.id,
  // ...
  sandbox: account.is_sandbox,  // your real sandbox flag from the backing store
};
```

The worked example at [`examples/hello_seller_adapter_signal_marketplace.ts`](../examples/hello_seller_adapter_signal_marketplace.ts) demonstrates this end-to-end with Addie (the storyboard runner) marked `sandbox_only: true`.

## Custom `authenticate()` callbacks

Adopters with custom auth (not using `verifyApiKey` / `verifyBearer` / `verifySignatureAsAuthenticator`) need to populate `credential` on the returned `AuthPrincipal` to opt into registry routing.

```ts
// Before — legacy shape
serve(createAgent, {
  authenticate: async (req) => {
    const token = extractFromCustomHeader(req);
    const principal = await myCustomLookup(token);
    return principal ? { principal: principal.id, token, scopes: [] } : null;
  },
});

// After — populate `credential` to opt into the registry
import { createHash } from 'node:crypto';

serve(createAgent, {
  authenticate: async (req) => {
    const token = extractFromCustomHeader(req);
    const principal = await myCustomLookup(token);
    if (!principal) return null;
    return {
      principal: principal.id,
      token,
      scopes: [],
      // Stamp the kind-discriminated credential so BuyerAgentRegistry
      // can route on it. Use the same sha256 hash the framework's
      // verifyApiKey would use, so adopters mixing custom and built-in
      // authenticators key off the same key_id.
      credential: {
        kind: 'api_key',
        key_id: createHash('sha256').update(token).digest('hex').slice(0, 32),
      },
    };
  },
});
```

Custom callbacks that don't populate `credential` see `BuyerAgentRegistry.resolve` return `null` → `ctx.agent` stays undefined → framework's request flow is unchanged.

## Verifier-side: `verifySignatureAsAuthenticator`

If you're using HTTP-Sig auth, configure the verifier's `agentUrlForKeyid` callback so the framework can stamp `credential.agent_url`:

```ts
import { verifySignatureAsAuthenticator } from '@adcp/sdk/server';

const auth = verifySignatureAsAuthenticator({
  capability,
  jwks,
  resolveOperation: mcpToolNameResolver,
  // CONFIGURE THIS: maps the verified keyid back to the agent_url it
  // belongs to. The verifier stamps `credential.agent_url` from this
  // lookup; without it, the http_sig credential is omitted (no
  // agent_url available) and BuyerAgentRegistry.signingOnly returns
  // null on every signed request.
  agentUrlForKeyid: (keyid) => keyidToAgentUrlMap.get(keyid),
});
```

Per adcp#3831, the `agent_url` derivation rule is "the `agents[]` entry whose `jwks_uri` resolved the keyid." Your `agentUrlForKeyid` MUST follow this — don't return arbitrary URLs.

## Common pitfalls

### "I added the registry but `ctx.agent` is always undefined"

Three usual causes:
1. **No `credential` populated.** Custom `authenticate()` returns the legacy shape without `credential`. → Stamp `credential` on the returned `AuthPrincipal` (see § "Custom `authenticate()` callbacks").
2. **`signingOnly` registry but bearer auth.** `signingOnly` refuses non-`http_sig` credentials. → Use `bearerOnly` or `mixed`, OR migrate to `verifySignatureAsAuthenticator`.
3. **Resolver returns `null`.** Your DB doesn't have the credential's `key_id` / `agent_url`. → Check that the seed data in your onboarding ledger is keyed off the same hash the framework computes (sha256 hex prefix, 32 chars).

### "All my requests 403 with `reason: 'sandbox-only'`"

You set `sandbox_only: true` on a buyer agent but your `accounts.resolve` doesn't return `sandbox: true` on the resolved Account. The gate composes `agent.sandbox_only && account.sandbox !== true → reject`. Either:
- Drop `sandbox_only: true` from the agent record (production agent), OR
- Have your resolver populate `sandbox: true` on the account it resolves (sandbox account).

### "verifySignatureAsAuthenticator is wired but `signingOnly` returns null"

The verifier needs an `agentUrlForKeyid` callback to stamp `credential.agent_url`. Without it, the credential is omitted and the registry has nothing to look up. See § "Verifier-side" above.

### "I'm getting `PERMISSION_DENIED + scope: 'agent' + status: 'suspended'` on a buyer I just unsuspended"

The cache is serving the stale `status: 'suspended'` for up to `ttlSeconds`. Call `registry.invalidate(credential)` after you mutate the row, OR set a shorter TTL.

## Reference

- **Worked example**: [`examples/hello_seller_adapter_signal_marketplace.ts`](../examples/hello_seller_adapter_signal_marketplace.ts) — full adapter wiring with Addie + sandbox_only + caching.
- **Framework gate behavior**: [`test/server-buyer-agent-status-and-redaction.test.js`](../test/server-buyer-agent-status-and-redaction.test.js), [`test/server-buyer-agent-sandbox-only.test.js`](../test/server-buyer-agent-sandbox-only.test.js).
- **Cache decorator behavior**: [`test/lib/buyer-agent-cache.test.js`](../test/lib/buyer-agent-cache.test.js).
- **Phase 1 design issue**: [#1269](https://github.com/adcontextprotocol/adcp-client/issues/1269).
- **Phase 2 (gated on AdCP 3.1)**: [#1292](https://github.com/adcontextprotocol/adcp-client/issues/1292).
- **Spec PR for Phase 2's error codes**: [adcontextprotocol/adcp#3831](https://github.com/adcontextprotocol/adcp/pull/3831).

---

_Last updated: 2026-05-02. Questions: open an issue against [`adcontextprotocol/adcp-client`](https://github.com/adcontextprotocol/adcp-client/issues)._
