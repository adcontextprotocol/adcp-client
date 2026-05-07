# Web (server-side) OAuth flow

`@adcp/sdk` provides three OAuth flow shapes:

| Helper                                       | Shape                | When to use                                                                  |
| -------------------------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| `CLIFlowHandler`                             | class (`OAuthFlowHandler`) | Single-process loopback (`localhost:8766`) — CLIs and dev tools.       |
| `NonInteractiveFlowHandler`                  | class (`OAuthFlowHandler`) | Refresh-only contexts — storyboard runs, scheduled jobs, cron.         |
| `startWebOAuthFlow` / `completeWebOAuthFlow` | standalone functions | **Web servers** where `/oauth/start` and `/oauth/callback` may hit different processes. |

The web flow is **not** a class implementing `OAuthFlowHandler` — its
contract spans two HTTP requests and (typically) two processes, which the
flow-handler interface cannot model. Pass it to your router, not to
`MCPOAuthProvider`.

## What the SDK handles

1. PRM (`/.well-known/oauth-protected-resource{path}`) discovery.
2. AS resolution: `prm.authorization_servers[0]` falling back to the agent
   origin when PRM is genuinely absent (404 — RFC 9728 §3 marks the
   metadata document as optional). Connection / parse / 5xx errors are
   surfaced as `ProtectedResourceMetadataError`; we do **not** silently
   downgrade to local guessing on a transient failure.
3. Resource indicator: `prm.resource` (validated against the agent origin
   via `checkResourceAllowed`) falling back to
   `resourceUrlFromServerUrl(agent.agent_uri)`. Never guessed locally
   when PRM is present.
4. Scope: caller `scopeHint` > `prm.scopes_supported` > `clientMetadata.scope`.
5. Dynamic client registration when the agent has no `oauth_client` and
   the AS advertises `registration_endpoint`. By default we **reject**
   registrations that return `client_secret` (i.e. confidential clients);
   pass `allowConfidentialClient: true` if you intend to persist a
   long-lived AS credential to your agent storage.
6. PKCE generation, authorization URL construction, and token exchange via
   the MCP SDK's `client/auth.js` primitives. Refresh runs through
   `MCPOAuthProvider` on the next agent call and forwards `resource`
   automatically.

## Express integration

```ts
import {
  startWebOAuthFlow,
  completeWebOAuthFlow,
  safeReturnTo,
  type PendingWebFlowStore,
} from '@adcp/sdk';

// Generate a session-bound state cookie at /start, verify at /callback.
// Without this, the state we store in the pending row is replay-protected
// but not browser-bound — anyone with the link can finish your flow.
const STATE_COOKIE = 'adcp_oauth_state';

router.get('/oauth/start', async (req, res) => {
  const agent = await loadAgent(String(req.query.agent_id)); // adopter's agent loader
  const { authorizationUrl, state } = await startWebOAuthFlow({
    agent,
    redirectUri: `${baseUrl}/oauth/callback`,
    pendingFlowStore: pgPendingFlowStore, // your PendingWebFlowStore
    agentStorage: pgAgentStorage, // your OAuthConfigStorage (optional)
    carry: { user_id: req.user.id, return_to: req.query.return_to },
    // Optional: forward the scope hint from a prior 401 challenge (SEP-835).
    // scopeHint: req.query.scope,
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
      // Browser-binding: the state we set on the cookie at /start MUST
      // match the state the AS sends back to /callback.
      expectedState: req.cookies[STATE_COOKIE],
    });
    res.clearCookie(STATE_COOKIE);
    // safeReturnTo defaults to path-only redirects; pass allowedReturnHosts
    // if you need to support absolute URLs against an allowlist.
    res.redirect(safeReturnTo(carry?.return_to) ?? '/');
  } catch (err) {
    res.redirect(`/oauth-failed?reason=${encodeURIComponent(err.code ?? 'oauth_error')}`);
  }
});
```

## What you bring

- **`loadAgent(agentId)`** — your code; not provided by the SDK. The
  `/start` route uses it to look up the `AgentConfig`. The `/callback`
  route does not need it: `agentId` is round-tripped in the pending row,
  and `completeWebOAuthFlow` will call `agentStorage.loadAgent(agentId)`
  itself when persisting tokens.

- **`pendingFlowStore`** — implements `PendingWebFlowStore`. Two methods:
  `put(flow)` and `consume(state)`. `consume` MUST be a single atomic
  operation; canonical implementations:

  Postgres:

  ```sql
  -- put
  INSERT INTO pending_oauth_flows (state, payload, expires_at)
    VALUES ($1, $2::jsonb, $3);

  -- consume (atomic — DELETE … RETURNING)
  DELETE FROM pending_oauth_flows
    WHERE state = $1 AND expires_at > now()
    RETURNING payload;
  ```

  Redis:

  ```
  SET pending:flow:<state> <payload> EX 600 NX     # put
  GETDEL pending:flow:<state>                      # consume
  ```

  A `SELECT` followed by a separate `DELETE` is a replay vulnerability and
  DOES NOT satisfy this contract. The SDK ships a `PendingWebFlowStore`
  contract test (`describe('PendingWebFlowStore contract …')` in
  `test/lib/oauth-web-flow.test.js`) you can run against your store.

- **`agentStorage`** (optional) — implements `OAuthConfigStorage` (the
  same interface used by `MCPOAuthProvider`). Omit it if you'd rather
  handle persistence yourself; `completeWebOAuthFlow` returns the issued
  tokens and a `persisted: false` flag in that case.

`InMemoryPendingFlowStore` ships for tests and single-instance dev. Do
not use it in production — restarts lose every in-flight flow.

## Errors

- `InvalidOrExpiredFlowError` — `state` not present or past TTL. Treat as
  user-recoverable: prompt to re-authorize.
- `StateMismatchError` — caller passed `expectedState` and it didn't
  match the AS-supplied `state`. Almost always CSRF or a stale cookie.
- `TokenExchangeError` — AS rejected the code exchange. Carries
  `oauthErrorCode` (`invalid_grant`, `invalid_client`, …), `status`, and
  a redacted `body` for diagnostics. Treat `body` as sensitive — do not
  reflect it to the browser or write it to access logs unredacted.
- `ProtectedResourceMetadataError` — PRM fetch failed (network / parse /
  non-404 HTTP) or PRM advertised a `resource` whose origin does not
  match the agent. Either is a configuration bug worth surfacing.
- `AgentVanishedDuringFlowError` — `agentStorage.loadAgent(agentId)`
  returned undefined after a successful token exchange. The user's auth
  succeeded but you have no agent to attach it to; usually an
  inter-process delete race.
- `ConfidentialClientNotAllowedError` — DCR returned a `client_secret`
  and you did not opt into `allowConfidentialClient: true`. Either flip
  the flag (and store the secret carefully) or pre-register a public
  client and put the result in `agent.oauth_client`.
- `OAuthError` — generic catch-all; check `err.code` for the discriminator.

## Operational notes

- **TTL.** Defaults to `DEFAULT_WEB_FLOW_TTL_MS` (10 minutes). Lower if
  you want a tighter recovery window; do not raise without a reason.
- **PKCE verifier is a secret.** Encrypt it at rest if your store crosses
  a trust boundary.
- **Atomic consume is load-bearing.** Without it, a replayed callback
  (e.g. user double-clicks the AS redirect) can mint two tokens and
  burn the authorization code on the second attempt.
- **CSRF.** `expectedState` binds the flow to the user's browser. The
  SDK cannot do this for you because it can't see your session
  middleware — you stash `state` in a cookie at `/start` and pass it
  back in at `/callback`.
- **`carry` is attacker-influenced.** It's whatever the caller of
  `/oauth/start` put in the request. Always validate before reflecting
  (use `safeReturnTo` for redirect targets).
- **Refresh is not this module's job.** Once `oauth_tokens` are
  persisted, `MCPOAuthProvider` handles refresh on the next agent call
  and forwards `resource` into the refresh request automatically.
  Callers who DIY refresh against `oauth_tokens` are responsible for
  forwarding `resource` themselves.
