# HTTP Basic Auth — Gateway Setup Guide

Use `--auth-scheme basic` when your AdCP agent sits behind an API gateway that
requires RFC 7617 HTTP Basic authentication (Apigee, Kong, AWS API Gateway with
a `BasicAuthentication` policy, nginx `auth_basic`, etc.). This is the standard
pre-production shape for seller, signal, and creative agents that aren't yet
issuing bearer tokens.

## When to use Basic auth

| Scenario | Auth scheme |
|---|---|
| Agent is directly accessible (no gateway) | `bearer` (default) |
| Gateway enforces a shared `user:pass` credential | `basic` |
| Gateway issues OAuth / OIDC tokens | `--oauth` or `--client-id` / `--client-secret` |

## CLI setup

Save the alias once, then use it like any other alias:

```bash
# Register — supply 'user:pass' to --auth and pass --auth-scheme basic
adcp --save-auth myagent https://gw.example.com/mcp \
  --auth 'USER:PASS' \
  --auth-scheme basic

# Use the alias — Basic credential is sent automatically
adcp myagent get_products '{"brief":"coffee brands"}'

# Verify what was saved
adcp --list-agents
# → myagent  https://gw.example.com/mcp  Auth: HTTP Basic (user=USER)
```

The `--auth-scheme basic` flag also works ad-hoc on any `adcp` invocation:

```bash
adcp https://gw.example.com/mcp get_adcp_capabilities \
  --auth 'USER:PASS' --auth-scheme basic
```

## The auth_token-suppression invariant

This invariant is load-bearing. If it breaks, every Basic-auth user silently
regresses to receiving a `401` (or worse, a corrupt double-`Authorization`
header).

**Basic auth lives entirely on `headers.Authorization`.** When `--auth-scheme basic`
is active, the CLI encodes the credential as `Authorization: Basic <base64(user:pass)>`
and **does not** set `auth_token` on the agent config. This prevents the SDK from
emitting a competing `Authorization: Bearer …` alongside the Basic header.

The suppression is implemented inside `buildResolvedAuthOption` and the
`useBasicAuth` branch of the config builder in `bin/adcp.js`. If a future
contributor modifies that path, the regression guard is:

- `test/lib/cli-auth-scheme.test.js` — "wire test: basic alias sends
  `Authorization: Basic <b64(user:pass)>`, not Bearer" — spins up a loopback
  server and verifies the exact header value reaching the wire.
- `test/lib/basic-auth.test.js` — unit tests confirming that `type: 'basic'`
  routes to `headers.Authorization` and explicitly asserts `auth_token` is
  `undefined`.

**Don't add a competing bearer.** If you see both `Authorization: Basic …` and
`Authorization: Bearer …` in gateway logs, the suppression has regressed.

## Programmatic usage (TypeScript)

When calling `createTestClient` directly, pass the `type: 'basic'` shape as the
third argument:

```typescript
import { createTestClient } from '@adcp/sdk';

const client = createTestClient(
  'https://gw.example.com/mcp',
  'mcp',
  { auth: { type: 'basic', username: 'USER', password: 'PASS' } },
);
```

The SDK encodes the credential and sets `Authorization: Basic <base64>` on the
request. `auth_token` is never populated for `type: 'basic'`.

## Verifying gateway pass-through

To confirm your gateway forwards the `Authorization: Basic` header to the
upstream agent, adapt the loopback pattern from
`test/lib/cli-auth-scheme.test.js`:

```js
import http from 'node:http';

// Minimal server that 401s without the expected Basic header
const server = http.createServer((req, res) => {
  const auth = req.headers.authorization ?? '';
  const expected = 'Basic ' + Buffer.from('USER:PASS').toString('base64');
  if (auth !== expected) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
    return res.end('Unauthorized');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, result: {} }));
});
server.listen(0, '127.0.0.1');
```

Point `adcp --save-auth` at `http://127.0.0.1:<port>/mcp` and verify the server
returns 200 instead of 401.

## See also

- [`docs/CLI.md`](../CLI.md) — full CLI reference including all auth methods
- [`docs/guides/CTX-METADATA-SAFETY.md`](./CTX-METADATA-SAFETY.md) — why
  credentials must not appear in `ctx_metadata`
- RFC 7617 — The 'Basic' HTTP Authentication Scheme
