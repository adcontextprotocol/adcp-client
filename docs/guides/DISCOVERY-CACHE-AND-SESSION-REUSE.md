# Discovery cache and MCP session reuse

A server-side caller that makes one AdCP call per incoming request, building a `SingleAgentClient` (or `AgentClient`) per request because auth, headers or deadlines differ, used to pay for the SDK's whole setup sequence on every call: an endpoint probe, a `tools/list` and a `get_adcp_capabilities`, each on its own MCP session. Against a slow seller that comes straight out of the caller's deadline.

Two independent mechanisms remove that cost:

1. an **opt-in shared discovery cache** so client instances for the same agent and principal reuse one endpoint / `tools/list` / capabilities observation, and
2. **reusable MCP connections** that per-call correlation headers, `AbortSignal`s and timeouts no longer split, plus a public **connection scope** to run a whole workflow on one session.

## Shared discovery cache

```ts
import { AgentClient, createInMemoryAgentDiscoveryCache } from '@adcp/sdk';

// One per process (or implement AgentDiscoveryCache over your own store).
const discoveryCache = createInMemoryAgentDiscoveryCache({ maxEntries: 256 });

function clientFor(request: IncomingRequest) {
  return new AgentClient(
    {
      id: 'seller',
      name: 'Seller',
      agent_uri: 'https://seller.example/mcp',
      protocol: 'mcp',
      auth_token: request.token,
    },
    {
      discoveryCache: {
        cache: discoveryCache,
        authIdentity: request.authorizationScopeId, // principal + tenant + granted permissions
        ttlMs: 5 * 60_000, // default 5 minutes, max 24 hours
      },
    }
  );
}
```

### What is shared, and for how long

An entry holds the endpoint that discovery resolved, the `tools/list` input-schema map and the capabilities from an authoritative `get_adcp_capabilities` response. Every entry carries `observedAt` / `expiresAt`; the SDK enforces the TTL on read, whatever your backend does. A reader also applies its own `ttlMs`, so a short-TTL client cannot inherit a longer writer's freshness window. A long-lived client honors that bound for both endpoints and capabilities in its own in-memory copy.

### Isolation (the part to get right)

The key is a SHA-256 over:

| Input                                                | Why                                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| agent URL and protocol                               | endpoint identity                                                                                                      |
| `authIdentity`                                       | **caller-owned** principal. Deliberately _not_ derived from the token: you decide who may share evidence               |
| credential kind (anonymous, bearer, OAuth or header) | Keeps anonymous and authenticated discovery separate while allowing token rotation                                     |
| configured `adcpVersion` / `wireAdcpVersion`         | negotiated version                                                                                                     |
| every non-correlation, non-credential header         | unknown `x-*` tenant / routing / policy headers can select a different upstream view, so they fail closed into the key |
| request-signing identity and policy                  | `kind`, `kid`, `alg`, agent URL and signing policy; never the private key                                              |
| effective `allowPrivateIp`, `maxResponseBytes`       | the transport policy the evidence was gathered under (per-call `transport` overrides included)                         |

Not part of the key: correlation headers (`x-request-id`, `x-correlation-id`, `traceparent`, ...), and credential header values (`Authorization`, `x-adcp-auth`) — OAuth and `auth_token` credentials are also owned by `authIdentity`; a token rotation for the same authorization scope keeps the entry. **Choose `authIdentity` at least as narrow as the credential's authorization scope.** Change the identity or invalidate the cache when permissions change or access is revoked; use a distinct identity for anonymous access. Two principals must never share an identity. Keys are hashes and never contain the identity, token or header values.

Never shared:

- **Synthetic capabilities** (a seller with no `get_adcp_capabilities`, or whose capabilities call failed) stay private to the instance that built them.
- **Scoped `trustedFetchFn` calls** bypass the cache in both directions: their network boundary is per call.
- Entries are copied in and out, so mutating a returned capabilities object cannot poison the cache.

### Concurrency, cancellation, failures

- Cold concurrent clients for the same key share one in-process discovery: one leader discovers, followers wait for it under **their own** signal and request timeout. A leader that is cancelled or fails never fails its followers; they discover for themselves.
- A cache backend that throws, returns a malformed entry or hangs costs a rediscovery, never a failed call. Each cache read or mutation wait is bounded by a 2 second deadline and, for reads and automatic writes, by the caller's `AbortSignal`. Mutations of one key are ordered in-process. A timed-out backend mutation retains its place until it settles, so a late writer cannot overwrite or delete a newer seed; later mutation waits also time out while discovery proceeds live.
- The shared cache is in-process singleflight. Across processes each cold process still discovers once.

### Invalidation

- `client.invalidateDiscoveryCache()` drops this client's local evidence and the shared entry. `refreshCapabilities()` does the same and re-discovers.
- A feature check (`require`, or the pre-flight check before a task) that fails against **shared** evidence invalidates it and re-decides on live capabilities before refusing the call.
- A seller error of `VERSION_UNSUPPORTED`, `UNSUPPORTED_FEATURE`, `FEATURE_UNSUPPORTED`, `TOOL_NOT_FOUND`, `METHOD_NOT_FOUND` or `UNKNOWN_TOOL` invalidates the shared entry.
- A malformed or expired entry is deleted and treated as a miss. An entry older than this reader's shorter TTL is also a miss.
- In-process invalidation takes precedence over an earlier discovery still in flight. External backends with concurrent writers in other processes must supply their own atomic invalidation/versioning if they need that guarantee across processes.

### Pre-seeding

| Method                | Lifetime                                                       | Result                                              |
| --------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| `primeCapabilities`   | One client, bound to its capability scope                      | Synchronous; `true` if accepted, otherwise `false`  |
| `primeDiscoveryCache` | Shared cache, bound to explicit authorization identity and TTL | Asynchronous; `true` if accepted, otherwise `false` |

```ts
const ok = await client.primeDiscoveryCache({
  capabilities, // authoritative, non-synthetic
  toolSchemas, // optional when capabilities.discoveredTools is present
  endpoint: { agentUri: 'https://seller.example/mcp', mcpEra: 'modern' }, // optional
});
```

Unlike [`primeCapabilities`](../TYPE-SUMMARY.md) — which stays client-bound and scope-keyed — seeded evidence outlives the instance. It returns `true` only once the backing cache accepted the entry, and `false` (seeding nothing) for synthetic, malformed, uncloneable or foreign-origin evidence, or when the cache rejects the write. Without `endpoint` the first call of a cold client still runs the endpoint probe once.

## Reusable MCP connections

This behavior applies by default, including calls that pass a signal or timeout outside a connection scope. The process-wide legacy/OAuth session cache retains at most 20 connections per cache with LRU eviction and has no idle expiry. For request workflows with many distinct credentials, use a scope to bound session lifetime. At process shutdown, `closeConnections()` from `@adcp/sdk/advanced` closes the process-wide connections.

A reusable session is keyed only by what changes the _connection_: endpoint, credential, tenant / routing headers, signing identity, `allowPrivateIp`, a caller-injected fetch, and the workflow scope. These no longer choose or split a session:

- **Correlation headers**: `traceparent`, `tracestate`, `x-request-id`, `x-correlation-id`, `x-trace-id`, `x-span-id`, `x-debug-id`, `x-client-request-id`, `x-b3-*`, `x-amzn-trace-id`, `x-cloud-trace-context`, `x-datadog-*`, `sentry-trace`, and vendor-prefixed `x-<vendor>-request-id` / `-correlation-id` / `-trace-id` / `-span-id` / `-debug-id`. Names suggesting credentials or tenant/routing identity (including `auth`, `token`, `tenant`, `account`, `workspace`, `seat`, `advertiser`, `publisher`, `buyer` and `seller`) are never treated as correlation. **`baggage` stays in the key**: it can carry tenant or routing members. Any header outside the list above also stays in the key (fail closed).
- **`AbortSignal`** and **`requestTimeoutMs`**: they bound a call.

Each call still sends _its own_ correlation headers, deadline and cancellation on every request over the shared session (including concurrent calls), through per-call context rather than values frozen at connect time. Explicit caller headers win over ambient OpenTelemetry context.

Isolation properties:

- A cancelled or timed-out call tears down only its own request. It does not evict or terminate a session other calls are using; other failures retire the session and close it once its in-flight calls finish.
- A caller that joins another caller's in-flight connect waits under its own signal and timeout. If the creator cancels the connect, the joiner retries for itself, with at most two retries after foreign aborts.
- A caller-injected `fetchFn` (a per-call network trust boundary) keeps its own one-shot session outside a connection scope; inside a scope its identity is part of the key.
- Connections are never shared across credentials, tenant headers, signing identities or `allowPrivateIp` settings.

### Public connection scope

```ts
import { withMCPConnectionScope } from '@adcp/sdk'; // also from '@adcp/sdk/advanced'

await withMCPConnectionScope(async () => {
  await client.syncAccounts(accounts);
  await client.listCreativeFormats({});
  await client.getProducts(brief); // same MCP session
}); // the session is terminated once, here
```

Await every operation before the scope callback returns; the callback owns the session lifetime. Open process-wide sessions can keep sockets alive, so close them at shutdown.

Inside a scope the endpoint probe, capability discovery, `tools/list` and tool calls share one negotiated session per identity. `closeScopedConnections()` closes the current scope's sessions early and does nothing when no MCP scope is active. Nested `withMCPConnectionScope` calls join the outer scope unless you pass `{ isolate: true }`.

### One exception: the first legacy handoff

For a seller on the pre-2026 MCP protocol era, the SDK negotiates with the v2 client first and then hands the call to the v1 client so 2025 Tasks keep working. That handoff is a cold cost the SDK cannot avoid: the first scope against such a seller opens one classification handshake plus one shared v1 session. Within the scope everything after that (probe aside) shares the v1 session, including `tools/list`, and the classification is remembered across scopes for five minutes, so a later scope opens only its own session. Modern-era sellers need a single negotiation per scope.

### Troubleshooting cache misses

Unknown headers participate in identity. A varying header such as `x-forwarded-for` causes a cache miss even when `authIdentity` matches. Also check version, transport policy, signing policy and TTL before assuming the cache backend failed.

## Related

- [Session reuse for multi-tool workflows](https://github.com/adcontextprotocol/adcp-client/issues/2118).
