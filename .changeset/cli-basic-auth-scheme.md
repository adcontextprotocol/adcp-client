---
'@adcp/sdk': minor
---

feat(cli): `--auth-scheme bearer|basic` for HTTP Basic auth (RFC 7617)

The CLI's `--auth TOKEN` flag was bearer-only — it always emitted
`Authorization: Bearer …` and silently dropped any `-H Authorization=…`
override via the reserved-header filter. Any agent fronted by an API
gateway that requires `Authorization: Basic <base64(user:pass)>` (Apigee,
Kong, AWS API Gateway with a BasicAuthentication policy, or just a
self-hosted nginx with `auth_basic`) was therefore unreachable from
`adcp <alias> <tool>` even though the underlying library already supported
basic via `createTestClient({ auth: { type: 'basic', … } })`.

`--auth-scheme bearer|basic` opts into the alternate scheme, applied across
every CLI surface that takes `--auth`:

- `adcp <alias> <tool>` (the direct `mcp`/`a2a` invocation path)
- `adcp test <agent>`
- `adcp storyboard run <agent> …` (single-instance, multi-instance, and
  multi-agent routing)
- `adcp storyboard step <agent> …`

Usage:

```bash
# Ad-hoc against a gateway-fronted agent
adcp https://agent.example.com/mcp tools/list \
  --auth svc-user:s3cret --auth-scheme basic

# Saved alias (scheme persists in ~/.adcp/config.json so future calls
# don't need to repeat --auth-scheme)
adcp --save-auth inmobi-prod https://agent.example.com/mcp \
  --auth svc-user:s3cret --auth-scheme basic
adcp inmobi-prod get_products '{"brief":"coffee"}'
```

Env-var form: `ADCP_AUTH_SCHEME=basic` (overridden by the flag).

Behavior:

- `--auth <user:pass>` is RFC 7617-validated at register time and again
  at use time — colon-less, empty-username, CR/LF, and non-printable
  ASCII inputs are rejected with a clear stderr message before any
  request leaves the CLI. A typo doesn't get persisted only to surface
  as a confusing decode error on every later call.
- When basic auth is in effect, the CLI injects the encoded
  `Authorization: Basic …` header via `agentConfig.headers` (which the
  protocol layer at `src/lib/protocols/mcp.ts` and `protocols/a2a.ts`
  spreads BEFORE the SDK's bearer header). The bearer path is suppressed
  so there's no scheme collision on the wire.
- `--list-agents` surfaces the scheme (`Auth: token configured (basic
(user:pass))`) so operators can tell at a glance whether an alias
  speaks bearer or basic.
- Bearer remains the default; existing aliases and CI commands behave
  identically. Saved bearer aliases do NOT gain an `auth_scheme: "bearer"`
  field on rewrite (only `"basic"` is persisted) to keep config diffs
  clean.

Mutually exclusive with `--oauth` and the client-credentials flags — the
CLI rejects combinations at parse time rather than silently picking one.
