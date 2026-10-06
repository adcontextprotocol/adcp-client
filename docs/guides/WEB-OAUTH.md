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
permit replay. Store contract tests: `test/lib/oauth-web-flow.test.js`.
`DEFAULT_WEB_FLOW_TTL_MS` is 10 minutes; shorten as needed. `InMemoryPendingFlowStore` is
test/dev-only; restarts lose flows. Encrypt PKCE verifiers at rest across trust boundaries.

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
