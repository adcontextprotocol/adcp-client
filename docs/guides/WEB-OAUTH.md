# Web OAuth

Web routes span processes; `CLIFlowHandler` is single-process localhost:8766,
`NonInteractiveFlowHandler` is refresh-only. Web flows are not provider handlers. [Issuer binding](OAUTH-ISSUER-BINDING.md) covers recovery/storage migration.

## Discovery

- PRM: `/.well-known/oauth-protected-resource{path}`, first AS. Only 404 absence
  (RFC 9728 §3) allows agent-origin fallback; network/parse/other HTTP failures
  raise `ProtectedResourceMetadataError`.
- Resource: `resourceOverride` > validated `prm.resource` >
  `resourceUrlFromServerUrl(agent.agent_uri)`. Present PRM is authoritative;
  its resource origin must match the agent unless explicitly/persistently overridden. Forward
  resource through authorization, exchange and refresh.
- Scope: `scopeHint` > `prm.scopes_supported` > `clientMetadata.scope`.
- DCR requires no client and an advertised `registration_endpoint`. Confidential
  DCR responses require `allowConfidentialClient: true` and safe secret storage;
  otherwise use pre-registered clients. Official MCP handles PKCE/exchange;
  subsequent agent calls refresh.

## Application routes

```ts
import { startWebOAuthFlow, completeWebOAuthFlow, safeReturnTo } from '@adcp/sdk/auth';

const STATE_COOKIE = 'adcp_oauth_state';
router.get('/oauth/start', async (req, res) => {
  const agent = await loadAgent(String(req.query.agent_id));
  const { authorizationUrl, state } = await startWebOAuthFlow({
    agent,
    redirectUri: `${baseUrl}/oauth/callback`,
    pendingFlowStore: pgPendingFlowStore,
    agentStorage: pgAgentStorage,
    carry: { user_id: req.user.id, return_to: req.query.return_to },
  });
  res.cookie(STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: 'lax' });
  res.redirect(authorizationUrl);
});
router.get('/oauth/callback', async (req, res) => {
  try {
    const { carry } = await completeWebOAuthFlow({
      state: String(req.query.state),
      code: String(req.query.code),
      pendingFlowStore: pgPendingFlowStore,
      agentStorage: pgAgentStorage,
      expectedState: req.cookies[STATE_COOKIE],
    });
    res.clearCookie(STATE_COOKIE);
    res.redirect(safeReturnTo(carry?.return_to) ?? '/');
  } catch {
    res.redirect('/oauth-failed?reason=oauth_error');
  }
});
```

`loadAgent` must authorize the session user for `agent_id`. Bind browser state
using the start cookie and callback
`expectedState`: state alone prevents replay, not CSRF; missing binding refuses.
`allowUnboundState: true` is for deliberate non-browser compatibility. Validate
attacker-controlled `carry`; `safeReturnTo` is path-only unless `allowedReturnHosts`
allowlists absolute URLs.

Start accepts prior-401 `scopeHint` (SEP-835), `resourceOverride`, and authorization-only
Auth0 `audience`. With storage, overrides persist/reuse on omission; successful
`resourceOverride: null` clears them and returns to discovery. DIY refresh forwards resource.

## Storage and errors

`PendingWebFlowStore`: `put(flow)` and atomic `consume(state)`, e.g. PostgreSQL
`DELETE ... WHERE state = $1 AND expires_at > now() RETURNING payload`, or Redis
`SET pending:flow:<state> <payload> EX 600 NX` then `GETDEL`. SELECT/DELETE races
permit replay. Check your store with `assertPendingWebFlowStoreRoundTrip` (below).
`DEFAULT_WEB_FLOW_TTL_MS` is 10 minutes; shorten as needed. `InMemoryPendingFlowStore` is
test/dev-only; restarts lose flows. Encrypt PKCE verifiers at rest across trust boundaries.

Use `serializePendingWebFlow` and `parsePendingWebFlow` from `@adcp/sdk/auth`
for the stored payload. The parser validates SDK-owned fields, revives `createdAt`
and `expiresAt` as `Date` values, and returns `null` for malformed input. It accepts
JSON strings and decoded JSON values such as `pg`'s `jsonb` payloads. It preserves
unknown fields and all client metadata, including `issuer` and `client_secret`.
Do not narrow the persisted shape to today's fields: a hand-written schema that
strips new optional fields can type-check while breaking sign-in after an SDK upgrade.

```ts
import { parsePendingWebFlow, serializePendingWebFlow } from '@adcp/sdk/auth';
import { assertPendingWebFlowStoreRoundTrip } from '@adcp/sdk/testing';

// In put(flow), serialize before encrypting and inserting with duplicate rejection:
const payload = serializePendingWebFlow(flow);

// In consume(state), decrypt the payload returned by atomic get-and-delete:
function restoreConsumedFlow(state: string, decryptedPayload: unknown) {
  const restored = parsePendingWebFlow(decryptedPayload);
  return restored && restored.state === state && restored.expiresAt.getTime() > Date.now()
    ? restored
    : null;
}

// In CI, use a disposable instance of your production store on each SDK upgrade:
await assertPendingWebFlowStoreRoundTrip(pendingFlowStore);
// Stores with application-owned constraints can supply valid fixture values:
await assertPendingWebFlowStoreRoundTrip(pendingFlowStore, {
  agentId: testAgentId,
  carry: { user_id: testUserId, nested: { values: ['one', 2, null] } },
});
```

The helper checks every current SDK field (including nested `carry` and issuer-bound
client secrets), Date revival, missing states, single use, expired rows, duplicate
rejection, and concurrent consume. It also checks null/absent snapshots, clear actions,
public clients, registration metadata, and unknown extensions. Stores may reject
already-expired inserts; the helper still checks that consumption returns `null`.
Its fixture is exhaustive at SDK build time, including optional flow and client
information fields. The concurrency check is a smoke test; the backend must
provide atomic deletion across processes. Use JSON-serializable `carry` and validate
its application-owned contents separately. Keep absent optional fields absent when
hydrating rows; an undefined-valued own `resourceOverrideSnapshot` can trigger the
callback's concurrent-edit guard. The store still owns encryption of PKCE
and client secrets, TTL, duplicate rejection, atomic consume, and binding the payload's
`state` to its storage key. The parser does not filter expired flows or establish
issuer trust; `completeWebOAuthFlow` also enforces expiry and issuer binding.

Optional `agentStorage` (`OAuthConfigStorage`): callback loads the pending row's
agent ID. Without it, completion
returns `persisted: false` for application persistence. Preserve the issuer guide's
consistent client-bearing view and partial-save contract.

- `InvalidOrExpiredFlowError`: restart sign-in.
- `StateMismatchError`: cookie/state mismatch.
- `BrowserBindingRequiredError`: missing `expectedState`.
- `TokenExchangeError`: diagnostic `oauthErrorCode`, `status`, redacted `body`;
  never reflect bodies to browsers/logs.
- `ProtectedResourceMetadataError`: PRM/resource failure.
- `AgentVanishedDuringFlowError`: removal during registration/exchange.
- `AgentChangedDuringFlowError`: URI/resource/client changed; reload and restart.
- `ConfidentialClientNotAllowedError`: secret DCR without opt-in.
- `OAuthError`: other controlled `code` values.
