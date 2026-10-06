# Web OAuth

Use `startWebOAuthFlow` / `completeWebOAuthFlow` in application routes when start
and callback can hit different processes. `CLIFlowHandler` implements
`OAuthFlowHandler` for single-process localhost:8766 sign-in;
`NonInteractiveFlowHandler` is refresh-only for jobs. Web flows span two
requests and are not an `MCPOAuthProvider` handler.

See [issuer binding](OAUTH-ISSUER-BINDING.md) for credential preservation,
pending-flow migration and explicit owner recovery.

## SDK behavior

- Discover PRM at `/.well-known/oauth-protected-resource{path}`. Use its first
  authorization server; fall back to agent origin only on absent PRM (404,
  RFC 9728 §3). Network, parse and other HTTP failures raise
  `ProtectedResourceMetadataError`, without guessing another server.
- Resource: `resourceOverride` > validated `prm.resource` >
  `resourceUrlFromServerUrl(agent.agent_uri)`. Present PRM is authoritative;
  its resource origin must match the agent unless an explicit or persisted override applies.
  Forward resource through authorization, exchange and refresh.
- Scope: `scopeHint` > `prm.scopes_supported` > `clientMetadata.scope`.
- Register when no client exists and AS advertises `registration_endpoint`.
  Confidential DCR responses require explicit `allowConfidentialClient: true`
  and safe secret storage; otherwise pre-register a public client.
- PKCE, authorization and exchange use official MCP primitives. Provider refresh
  runs on later agent calls.

## Express integration

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

The application authorizes `loadAgent` and binds state to its browser session.
Pending state alone is replay-protected, not browser-bound. Set it at start and
pass it as `expectedState` at callback; omission fails closed. Only deliberate
non-browser compatibility flows should set `allowUnboundState: true`.
Validate attacker-influenced `carry`; `safeReturnTo` defaults to path-only
redirects, with `allowedReturnHosts` for explicitly allowlisted absolute URLs.

Start accepts `scopeHint` from a prior 401 challenge (SEP-835), an operator
`resourceOverride`, and Auth0-compatible `audience` for authorization only.
With storage, resource override persists for refresh; omission reuses it.
Pass `resourceOverride: null` to clear it after successful authorization and
return to PRM/agent discovery. DIY refresh must forward resource itself.

## Storage

`PendingWebFlowStore` implements `put(flow)` and atomic `consume(state)`.
Example PostgreSQL operations:

```sql
INSERT INTO pending_oauth_flows (state, payload, expires_at)
  VALUES ($1, $2::jsonb, $3);
DELETE FROM pending_oauth_flows
  WHERE state = $1 AND expires_at > now()
  RETURNING payload;
```

Redis can use `SET pending:flow:<state> <payload> EX 600 NX` and `GETDEL`.
Separate SELECT/DELETE permits replay and fails the contract. The contract
tests in `test/lib/oauth-web-flow.test.js` can exercise your store. Default
TTL is `DEFAULT_WEB_FLOW_TTL_MS` (10 minutes); shorten as needed.
`InMemoryPendingFlowStore` is for tests/dev; restarts lose flows. Encrypt
PKCE verifiers at rest across trust boundaries.

Optional `agentStorage` implements `OAuthConfigStorage`; callback loads the
pending row's agent ID itself. Without storage, completion returns tokens with
`persisted: false` for application persistence. The issuer guide describes the
required consistent client-bearing view and partial-save contract.

## Errors

- `InvalidOrExpiredFlowError`: missing/expired state; restart sign-in.
- `StateMismatchError`: cookie/state mismatch, usually CSRF or a stale cookie.
- `BrowserBindingRequiredError`: missing `expectedState`.
- `TokenExchangeError`: AS rejected exchange; `oauthErrorCode`, `status` and
  redacted `body` are diagnostic only. Never reflect sensitive body data to
  browsers or access logs.
- `ProtectedResourceMetadataError`: failed PRM or mismatched resource origin.
- `AgentVanishedDuringFlowError`: agent removed during registration/exchange.
- `AgentChangedDuringFlowError`: URI, resource or client changed; reload and
  restart rather than saving against a replacement record.
- `ConfidentialClientNotAllowedError`: DCR returned a secret without opt-in.
- `OAuthError`: inspect `code` for other controlled failures.
