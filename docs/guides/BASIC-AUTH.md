# HTTP Basic auth for gateway-fronted agents

Some AdCP agents sit behind an enterprise gateway (Apigee, Kong, AWS API Gateway, nginx `auth_basic`, Cloudflare Access) that requires **HTTP Basic** authentication (RFC 7617) before the request reaches the underlying MCP/A2A server. This is a common pre-prod shape: the agent itself doesn't know about HTTP-level auth, but you can't get to it without `Authorization: Basic …`.

The SDK and CLI support this directly. This guide covers when to use it, the worked CLI example, the load-bearing invariant adopters and contributors must respect, and how to verify the wire trace.

## When to use this

Pick `--auth-scheme basic` when:

- The agent URL is fronted by a gateway that enforces HTTP Basic before routing.
- You have a `user:pass` credential pair (issued by the gateway operator) rather than a bearer token.
- `curl -u user:pass https://gw.example.com/mcp` works against the same URL.

Do **not** use basic auth when:

- The agent itself accepts a bearer token directly (use `--auth <token>`, the default scheme).
- The agent speaks OAuth (use `--oauth` or `--client-id`/`--client-secret`).

## CLI

```bash
# Save the agent with basic-auth credentials. The user:pass pair is base64-
# encoded and stored under headers.Authorization in ~/.adcp/config.json.
adcp --save-auth my-gw https://gw.example.com/mcp \
  --auth 'USER:PASS' \
  --auth-scheme basic

# Use it like any other saved alias.
adcp my-gw get_products '{"brief":"…"}'

# Or, one-shot without saving:
adcp https://gw.example.com/mcp get_products '{"brief":"…"}' \
  --auth 'USER:PASS' --auth-scheme basic
```

Both forms set `Authorization: Basic <base64(user:pass)>` on every request the SDK sends to the agent — the precheck (`get_adcp_capabilities`, `tools/list`), the tool call itself, and any follow-up requests.

The CLI validates the credential shape before sending: the username is checked for the RFC 7617 ban on `:`, and both halves are checked for CR/LF/NUL. Invalid credentials fail at parse time, not on the wire.

## SDK

When constructing an agent config programmatically, put the encoded `Authorization` header on `agent.headers` and **do not** set `auth_token`:

```ts
import { ADCPClient } from '@adcp/sdk';

const client = new ADCPClient({
  id: 'my-gw',
  agent_uri: 'https://gw.example.com/mcp',
  protocol: 'mcp',
  name: 'gateway-fronted agent',
  headers: {
    Authorization: 'Basic ' + Buffer.from('USER:PASS').toString('base64'),
  },
});

const info = await client.getAgentInfo();
```

## The invariant: don't pair `auth_token` with basic auth

Basic-auth credentials live **entirely** on `headers.Authorization`. The CLI intentionally suppresses `agent_config.auth_token` when `--auth-scheme basic` is in effect (`bin/adcp.js`, the `agentConfig` build), and the SDK forwards `headers` through every transport branch (`SingleAgentClient.getAgentInfo` → `connectMCP`).

**Why this matters.** If `auth_token` is set alongside a basic-auth `headers.Authorization`, the SDK emits a competing `Authorization: Bearer …` that overrides the basic credential on some code paths, and the agent receives the wrong scheme. This was the failure mode in [#1864](https://github.com/adcontextprotocol/adcp-client/issues/1864) (closed in #1866) — basic-auth agents silently 401'd on every tool call because the precheck path dropped the basic header and there was no bearer to fall back to.

If you're editing the auth resolution path in `bin/adcp.js` or `SingleAgentClient`, preserve this separation: basic auth → `headers` only; bearer → `auth_token`; OAuth → `oauth_tokens`. Never combine bearer with basic.

## Verifying the wire trace

The regression test at `test/lib/get-agent-info-basic-auth.test.js` stands up a loopback MCP server that 401s without `Authorization: Basic`, then asserts every request the SDK makes — including the `tools/list` precheck — carries the header. The pattern is copyable for adopter integration tests against your own gateway. Approximate shape:

```js
const http = require('node:http');
const { AgentClient } = require('@adcp/sdk');

const credential = 'Basic ' + Buffer.from('user:pass').toString('base64');
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== credential) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="adcp"' });
    res.end('unauthorized');
    return;
  }
  // ... handle initialize / tools/list / tools/call ...
});

const client = new AgentClient({
  id: 'gw',
  agent_uri: `http://127.0.0.1:${port}`,
  protocol: 'mcp',
  name: 'gw',
  headers: { Authorization: credential },
});

const info = await client.getAgentInfo();
// If the server 401s, you'll get an `MCP_AUTH_REJECTED` error with
// `error.scheme === 'header'` and a remediation hint — see #1869 for shape.
```

If the SDK returns a 401, the wrapped error includes the scheme it actually used (`bearer` / `header` / `oauth` / `none`) and a remediation hint. Check `error.scheme === 'header'` to confirm the basic header reached the wire; check `error.scheme === 'bearer'` if you accidentally set both `auth_token` and `headers.Authorization` (the bearer wins and you'll see `Bearer` here instead of `header`).

## Common adopter pitfalls

- **Setting `auth_token` "just in case."** Don't. See the invariant above.
- **Putting `user:pass` raw on `headers.Authorization`.** The value must be `'Basic ' + base64(user:pass)`. The CLI does this for you; the SDK does not.
- **Using a `:` in the username.** RFC 7617 forbids it. The CLI rejects this at parse time; raw SDK construction will be silently mis-parsed by the gateway.
- **Cookie-based session auth fronting the gateway.** Not supported — use OAuth or per-request bearer.

## See also

- CLI reference: [`docs/CLI.md`](../CLI.md#authentication-methods)
- Source of truth for the invariant: `bin/adcp.js` `injectBasicAuthHeader`, `SingleAgentClient.getAgentInfo` (search for `customHeaders`).
- Regression tests: `test/lib/get-agent-info-basic-auth.test.js`, `test/lib/connect-mcp-401-context.test.js`, `test/lib/cli-auth-scheme.test.js`.
- Issues: [#1864](https://github.com/adcontextprotocol/adcp-client/issues/1864) (precheck-path bug, closed in #1866), [#1865](https://github.com/adcontextprotocol/adcp-client/issues/1865) (banner mislabel, closed in #1866), [#1869](https://github.com/adcontextprotocol/adcp-client/issues/1869) (401-error context).
