# Validate Your Agent With Mock Upstream Fixtures

Most AdCP agents are **adapters** — they wrap an upstream platform (a DSP, SSP, retail data warehouse, creative server, signal marketplace) and translate its API into the AdCP wire contract. The hard part of validating these agents is proving they actually integrate with the upstream, not that they return shape-valid AdCP responses with synthetic data.

This guide describes the pattern: boot a published mock fixture that mimics a real upstream, point your agent at it, run the storyboard runner, then assert the agent actually called the upstream's headline endpoints. It works for any agent in any language.

If your agent doesn't wrap an upstream platform — for example, a pure decisioning service that owns its own data — you don't need this; the [`VALIDATE-YOUR-AGENT.md`](./VALIDATE-YOUR-AGENT.md) checklist covers you.

---

## TL;DR — four steps

```bash
# 1. Boot the mock upstream for your specialism
adcp mock-server sales-social --port 4250 &

# 2. Run your AdCP agent, configured to use http://localhost:4250 as its upstream
./your-agent.sh        # Python/Go/Rust/TS — doesn't matter

# 3. Grade your agent against the storyboard
adcp storyboard run http://localhost:3001/mcp sales_social \
  --auth $TOKEN --json > grader.json

# 4. Assert your agent actually called the upstream
curl -s http://localhost:4250/_debug/traffic
# {"traffic": {"POST /oauth/token": 1, "POST /event/track": 6, ...}}
```

Step 3 catches AdCP wire bugs (response shape, error codes, idempotency). Step 4 catches **façade adapters** — agents whose handlers return shape-valid AdCP responses without actually integrating with the upstream. Both signals matter; one without the other is incomplete.

---

## Why traffic counters matter — the façade pattern

A storyboard validates the AdCP wire contract: did the response match the schema, did the agent advertise the right tools, did context echo. It cannot tell whether the adapter behind the wire is doing real work.

Empirically observed (in our own test runs, before we shipped traffic counters): an LLM-built adapter wrote OAuth client code, declared the import, and never called it. The handler returned hardcoded shape-valid responses for every call. Storyboard graded `passing`. Real upstream traffic: zero requests.

A more sophisticated variant: the adapter calls the upstream, but with synthetic placeholder data:

```typescript
const SYNTHETIC_HASH = sha256Hex('placeholder@example.com');
// ...
user_data: { email_sha256: SYNTHETIC_HASH };
```

The mock upstream accepts the placeholder; a real upstream would reject. Storyboard still passes (response shape is valid). The traffic counter would catch the simpler case (handler short-circuits before calling upstream); harder cases require the storyboard to exercise the full payload contract.

Net: **traffic counters are the strongest single signal that an adapter actually integrates**. The storyboard is your shape check; traffic is your honesty check.

---

## What's available

The published `@adcp/sdk` CLI ships four mock-server specialisms covering distinct upstream surface shapes:

| Specialism | Mimics | Auth | Multi-tenant scope | AdCP-side identifier the adapter receives |
|---|---|---|---|---|
| `signal-marketplace` | LiveRamp / Lotame / data marketplace | Static Bearer (`Authorization: Bearer …`) | `X-Operator-Id` header | `account.operator` |
| `creative-template` | Celtra / Innovid creative-management platform | Static Bearer | `/v3/workspaces/{ws}/…` path-scoped | `account.operator` (workspace handle) |
| `sales-social` | TikTok / Meta-shaped social ads platform | OAuth 2.0 client_credentials with refresh | `/v1.3/advertiser/{advertiser_id}/…` path-scoped | `account.advertiser` |
| `sales-guaranteed` | GAM / FreeWheel guaranteed-sales platform | Static Bearer | `X-Network-Code` header | `account.publisher` |

Each mock exposes:

- **The upstream's domain endpoints** (e.g. `POST /oauth/token`, `POST /v1.3/advertiser/{id}/event/track`) shaped to match the real platform's contract closely enough that an adapter built blind from the mock's OpenAPI spec will work against the real thing with minimal changes.
- **`GET /_lookup/<resource>?<adcp_field>=<value>`** — runtime resolution. Your adapter receives an AdCP-side identifier (e.g. `account.advertiser: "novamotors.example"`) and translates it to the upstream's tenant ID by calling `_lookup`. **Don't hardcode mappings**; use the lookup endpoint at runtime, exactly as you would against a production directory service.
- **`GET /_debug/traffic`** — hit counters keyed by `<METHOD> <route-template>`. Read-only, no auth, harness-only. Your test runner queries this after the storyboard run to assert which routes the adapter exercised.

OpenAPI spec for each mock lives in the published package at `node_modules/@adcp/sdk/dist/lib/mock-server/<specialism>/openapi.yaml`. Reference your adapter against this spec, not against any specific seed data.

---

## The four-step recipe in detail

### 1. Boot the mock-server

```bash
# Default port 4500
adcp mock-server sales-social --port 4250

# OAuth specialisms print their client credentials at startup; static-bearer
# specialisms accept --api-key to override the default test key.
adcp mock-server signal-marketplace --port 4150 --api-key sk_test_abc123
```

The mock runs in the foreground; `Ctrl-C` to stop, or run with `&` for background. Boot summary prints the auth credentials and the AdCP fields the adapter will receive — *not* specific values. Specific lookup values live behind `/_lookup`, which is what makes blind testing possible.

### 2. Configure your agent to use the mock as its upstream

This is your code, in whatever language. The pattern:

- Set the upstream URL from an env var or config (e.g. `UPSTREAM_URL=http://localhost:4250`).
- For OAuth specialisms, exchange the client credentials at the printed token endpoint and attach `Authorization: Bearer <access_token>` to subsequent requests.
- For static-bearer specialisms, attach `Authorization: Bearer <api_key>`.
- Add the per-tenant header (`X-Operator-Id` / `X-Network-Code`) or path scope as required by the upstream.
- For each AdCP request, resolve the adapter's `account.<field>` to the upstream tenant ID via `GET <upstream>/_lookup/<resource>?<field>=<value>`, then call the appropriate upstream endpoint.

Example, `httpx` in Python (~30 lines):

```python
import httpx, os
UPSTREAM = os.environ['UPSTREAM_URL']
CID = os.environ['UPSTREAM_CLIENT_ID']
CSECRET = os.environ['UPSTREAM_CLIENT_SECRET']

class UpstreamClient:
    def __init__(self):
        self._token = None
    async def _ensure_token(self):
        if self._token: return
        r = await httpx.AsyncClient().post(
            f"{UPSTREAM}/oauth/token",
            json={"grant_type": "client_credentials", "client_id": CID, "client_secret": CSECRET},
        )
        self._token = r.json()["access_token"]
    async def lookup_advertiser(self, adcp_advertiser: str) -> str | None:
        await self._ensure_token()
        r = await httpx.AsyncClient(headers={"Authorization": f"Bearer {self._token}"}).get(
            f"{UPSTREAM}/_lookup/advertiser", params={"adcp_advertiser": adcp_advertiser},
        )
        return r.json()["advertiser_id"] if r.status_code == 200 else None
    # ...etc
```

Same shape in Go, Rust, Ruby. The TS reference implementations are in the SDK at `src/lib/mock-server/<specialism>/server.ts` if you want to read what the upstream side looks like.

### 3. Run the storyboard runner

```bash
# The agent is on http://localhost:3001/mcp; storyboard ID is 'sales_social' or
# whatever specialism your agent claims.
adcp storyboard run http://localhost:3001/mcp sales_social \
  --auth $TOKEN \
  --json > grader.json
```

Read `grader.json` for the full per-step report. The headline you want is `overall_status: passing`. `partial` is acceptable with caveats (see "Known limitations" below). `failing` means a step's wire contract was violated; the per-step `details` field tells you which assertion failed.

### 4. Assert the upstream was actually called

```bash
curl -s http://localhost:4250/_debug/traffic | jq
# {"traffic": {
#   "POST /oauth/token": 1,
#   "GET /_lookup/advertiser": 4,
#   "POST /v1.3/advertiser/{id}/custom_audience/upload": 2,
#   "POST /v1.3/advertiser/{id}/event/track": 6
# }}
```

For each specialism, the headline endpoints we expect to see ≥1 hit on are:

| Specialism | Required hits |
|---|---|
| `signal-marketplace` | `GET /_lookup/operator`, `GET /v2/cohorts`, `POST /v2/activations` |
| `creative-template` | `GET /_lookup/workspace`, `GET /v3/workspaces/{ws}/templates`, `POST /v3/workspaces/{ws}/renders` |
| `sales-social` | `POST /oauth/token`, `GET /_lookup/advertiser`, `POST /v1.3/advertiser/{id}/custom_audience/upload`, `POST /v1.3/advertiser/{id}/event/track` |
| `sales-guaranteed` | `GET /_lookup/network`, `GET /v1/products`, `POST /v1/orders`, `GET /v1/tasks/{id}` |

If any expected route shows zero hits, your handler for that path either short-circuited or never got exercised. Both are worth investigating — short-circuit means a façade; not-exercised means the storyboard's input didn't trigger that branch (which can mean either the storyboard under-covers the surface or your branching logic has a guard you didn't intend).

---

## Iteration loop

Realistically, your first run will not pass both gates. Common failure shapes:

- **Storyboard `passing` but traffic gate fails on N endpoints**: classic façade. Look at the missing routes; the handlers for those routes either have early-return paths that skip the upstream call, or the upstream call is on a code branch the storyboard's payloads don't trigger.
- **Storyboard `partial` with cascade skips**: a step early in the chain (often `get_products` or `get_signals`) returned a shape-valid response that's missing fields the runner extracts state from. Downstream steps skip with `unresolved context variables from prior steps: …`. Fix the early step's response shape and most cascade skips clear.
- **Storyboard `failing` on a single step + traffic gate clean**: usually a one-line shape bug — wrong field name, missing required field, status mismatch. The per-step `details` names the field via JSON pointer (`/products/0/format_ids/0/id: must be string`).
- **Traffic gate empty (0 hits everywhere) + agent appears to start**: agent boot threw a recoverable error after listening on port — for example, framework config validation that fails on first request. Check your agent's stderr.

The fastest debug loop:

1. Run `adcp storyboard step <agent> <storyboard_id> <step_id>` to isolate the failing step (this skips the cascade and runs a single tool call against your live agent — sub-second feedback).
2. Read the response your agent returned for that step (in the JSON output's `response` field).
3. Compare against the schema named in `validation.schema_id`.
4. Fix and re-run the step.

Skip the full storyboard until the isolated step passes — you'll save minutes per iteration.

---

## Known limitations (be honest with your team)

- **Storyboards under-cover payload variety.** A storyboard step may pass shape with an empty input where a real adapter never gets exercised on the variant that matters. This is the core limitation traffic counters work around. (Tracked at adcontextprotocol/adcp#3785.)
- **Storyboard cascade is fragile.** If an early step's response is shape-valid but missing fields the runner extracts state from, downstream steps silently skip. The error you see is on the *downstream* step, not the early one. Always investigate "skipped" steps before "failed" — the root cause is usually upstream of where the failure is reported. (Tracked at adcontextprotocol/adcp#3796.)
- **Mock seed data may not match your storyboard's fixture inputs.** If you're seeing 404s on `_lookup/<resource>`, the storyboard's payloads may reference IDs the mock doesn't seed. Either widen the mock's seed to include the storyboard's fixture domains, or use the comply test controller to seed scenario state at runtime.
- **Traffic gate is necessary, not sufficient.** A handler can call upstream with synthetic placeholder data and still satisfy the hit-count assertion. For agents in regulated channels (audience uploads, conversion tracking, signed requests), additional integration tests against the real upstream's payload validation are still needed before production.

---

## When to add this to your CI

The mock-server specialisms boot in <1 second; storyboard runs in 2–10 seconds for most specialisms; traffic check is a single curl. The full loop fits in a CI step under a minute. Recommended:

- Add the four-step recipe as a CI job that boots the mock, your agent, runs storyboard, asserts traffic.
- Fail the build on `traffic` gate failure, not just storyboard failure.
- Cache the mock-server's `node_modules` between runs (the published `@adcp/sdk` is small).

For agents that target multiple specialisms, run one job per specialism in parallel; each gets its own port pair.

---

## Cross-references

- [`VALIDATE-YOUR-AGENT.md`](./VALIDATE-YOUR-AGENT.md) — the broader validation checklist (fuzz, multi-instance, request-signing, webhook conformance). The mock-fixture loop is one tool in that toolbox; the others apply regardless of whether you wrap an upstream.
- [`VALIDATE-LOCALLY.md`](./VALIDATE-LOCALLY.md) — for in-process testing of TS adopters via `--local-agent <module>`. Doesn't replace the mock-fixture loop (you still want real HTTP between adapter and upstream) but is faster for adapter-internal logic.
- [`BUILD-AN-AGENT.md`](./BUILD-AN-AGENT.md) — the language-and-framework-agnostic guide to building an AdCP agent in the first place.
- [`CONFORMANCE.md`](./CONFORMANCE.md) — what each storyboard tests, what counts as conformance for each specialism.

The mock-server source — auth flows, OpenAPI specs, seed data, traffic-counter wiring — lives in the published SDK at `dist/lib/mock-server/<specialism>/`. If your upstream platform's contract diverges meaningfully from the mock, file an issue with the diff so we can update the mock or document the divergence.
