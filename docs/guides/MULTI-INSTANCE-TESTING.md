# Multi-instance Storyboard Testing

Catch horizontal-scaling bugs in your AdCP agent before production.

## The protocol requirement

The AdCP spec requires that `(brand, account)`-scoped state survive across agent process instances — a write on one replica MUST be readable from any other. See [State persistence and horizontal scaling](https://adcontextprotocol.org/docs/protocol/architecture#state-persistence-and-horizontal-scaling) for the normative text, and [Verifying cross-instance state](https://adcontextprotocol.org/docs/building/validate-your-agent#verifying-cross-instance-state) for the builder-facing guidance.

## The bug class

An agent deployed behind a load balancer — Fly.io with ≥2 machines, Kubernetes with >1 pod, an autoscaling fleet — can pass every storyboard against a single URL and still break in production:

1. Storyboard step 1 creates an entity on replica A.
2. Storyboard step 2 reads that entity. The load balancer routes to replica B.
3. Replica B has no record because state lived in replica A's process memory.
4. The read returns `NOT_FOUND`.

A single-URL storyboard never sees this. Multi-instance mode round-robins steps across two (or more) URLs that share a backing store. An agent whose state is `(brand, account)`-keyed and stored in a shared datastore passes; an agent whose state is per-process fails on the second request.

## Usage

```
npx @adcp/client storyboard run \
  --url https://a.your-agent.example/mcp/ \
  --url https://b.your-agent.example/mcp/ \
  account_and_audience \
  --auth $AGENT_TOKEN
```

- Repeat `--url` once per instance (minimum 2).
- The positional agent argument is disallowed in multi-instance mode — use `--url` flags only.
- A storyboard ID, bundle ID, or `--file <path>` is required. Full capability-driven assessment is single-URL only in this release.
- `--dry-run` prints the per-step instance assignment plan without executing.
- `--json` emits a per-step `agent_url` and `agent_index`; the top-level result gains `agent_urls[]` and `multi_instance_strategy`.

## What makes the test valid: (brand, account)-scoped state

Multi-instance mode asserts the protocol requirement: state keyed by `(brand, account)` survives across replicas. If your agent keys state only by the MCP session ID, each `--url` client gets a distinct session, and round-robin produces legitimate isolation — you will see false failures.

That is not a reason to disable multi-instance mode. It is a reason to fix the state-keying. An agent that only works inside one MCP session has already failed multi-tenant isolation, per the spec.

## Failure signature

When a step fails in multi-instance mode the runner appends a block to the error. The wording mirrors the canonical example in the protocol docs so you pattern-match the page you'll click through to:

```
create on replica [#1] (https://a.your-agent.example/mcp/) succeeded.
read on replica [#2] (https://b.your-agent.example/mcp/) failed with NOT_FOUND.
→ Brand-scoped state is not shared across replicas.
See: https://adcontextprotocol.org/docs/building/validate-your-agent#verifying-cross-instance-state
Replica → step map:
  [#1] create — ok
  [#2] read — FAIL
Reproduce single-replica: adcp storyboard run https://b.your-agent.example/mcp/ account_and_audience
```

The `Reproduce single-replica` command gives you the exact repro so you can confirm the bug is cross-replica, not intrinsic. Single-URL pass + multi-URL fail = horizontal-scaling bug.

## Local harness

A reference compose file ships at [`docs/examples/multi-instance/`](../examples/multi-instance/) — two app replicas + Postgres + Caddy round-robin proxy. Edit the agent image line, copy `.env.example` to `.env`, run `docker compose up -d --wait`. Supports both runner-level `--url` round-robin (hit both replicas directly at 4100, 4101) and LB-level rotation (hit Caddy at 4099).

For local dev without Docker, the simplest setup is two `node` processes listening on different ports, both pointed at the same Postgres / SQLite file / Redis instance.

## Live smoke test against the public test agent

Quick way to verify the multi-instance code path end-to-end against the AdCP public test agent:

```bash
npx @adcp/client storyboard run \
  --url "https://test-agent.adcontextprotocol.org/mcp/?replica=a" \
  --url "https://test-agent.adcontextprotocol.org/mcp/?replica=b" \
  property_lists \
  --auth $TEST_AGENT_TOKEN
```

The `?replica=a` / `?replica=b` query strings are a deliberate cache-busting trick. The MCP connection pool keys by URL, so two identical URL strings collapse onto one transport and one session — which defeats the whole test. Distinct query strings force two transports, two `Mcp-Session-Id`s, two independent `initialize` handshakes. Both requests still reach the same agent; the test exercises the full MCP-SDK multi-session code path even without per-replica DNS.

The test agent is correctly implemented — it runs behind Fly.io's round-robin routing with a shared Postgres store — so this run should show the property-list chain (create → list → get → update → validate → delete) passing across replica boundaries. A failure here means either the spec requirement broke in the test agent, or the runner regressed.

This command alternates which replica each step hits via round-robin. The runner's failure attribution also correctly distinguishes cross-replica failures from intrinsic ones — if a read fails on the *same* replica as its prior write (round-robin coincidence), the attribution message says so rather than falsely blaming cross-replica state.

## Distribution strategy

Two strategies are available via `--multi-instance-strategy`. The assignment is deterministic and reproducible — the same storyboard always hits the same URLs in the same order, so bug reports are stable.

### `round-robin` (default)

Step N is dispatched to `urls[N % urls.length]`. One pass. This is the default.

### `multi-pass` (narrow use case — read this before opting in)

**Multi-pass is not the recommended way to test cross-replica state persistence at N=2.** Single-pass round-robin covers adjacent write→read pairs, and the follow-up [dependency-aware dispatch (#607 option 2)](https://github.com/adcontextprotocol/adcp-client/issues/607) covers non-adjacent pairs without doubling wall-clock time. Multi-pass addresses a different, narrower concern.

Runs the storyboard `urls.length` times, each pass starting the dispatcher at a different replica. The first pass is standard round-robin (step N → `urls[N % N_urls]`); subsequent passes shift the starting replica so each step is served by each replica at least once across passes.

```bash
adcp storyboard run \
  --url https://api.example.com/mcp?replica=a \
  --url https://api.example.com/mcp?replica=b \
  --multi-instance-strategy multi-pass \
  property_lists
```

**When to use it.** Bugs isolated to one replica — stale config, divergent version, local-cache miss — where the buggy replica happens to serve only passive steps in a single round-robin pass. Multi-pass makes sure the buggy replica serves every step at some point.

**When NOT to use it.** If what you want to test is cross-replica state persistence (the spec requirement for horizontal scaling), single-pass round-robin and dependency-aware dispatch are the right tools. Multi-pass does not close the N=2 write→read coverage gap — see the limitation below.

**Known limitation (N=2 pair parity).** For N=2, offset-shift preserves pair parity. A write→read pair whose dispatch indices differ by an **even** amount lands same-replica in every pass — including the canonical `property_lists` case (write at step 0, intervening step at 1, read at step 2, distance 2). Pairs with odd-distance are already cross-replica in both passes under round-robin alone, so multi-pass adds no cross-replica coverage to them either. Multi-pass does flip parity for some pairs at N≥3, but that's rarely a real deployment shape.

**Cost.** Run time scales linearly with `urls.length`, plus per-pass MCP connection re-initialization. For a 2-replica 6-phase bundle, budget ~2× the single-pass wall clock.

**Output shape.** `runStoryboard` returns the aggregated `StoryboardResult`: `passed_count` / `failed_count` / `skipped_count` sum across passes, `overall_passed` ANDs across passes, top-level `phases` is the first pass (for backward compatibility), and the full per-pass detail lives in `passes[]` with each entry carrying `pass_index`, `dispatch_offset`, and that pass's `phases`.

```json
{
  "overall_passed": false,
  "multi_instance_strategy": "multi-pass",
  "passed_count": 7,
  "failed_count": 1,
  "phases": [/* first pass's phases */],
  "passes": [
    { "pass_index": 1, "dispatch_offset": 0, "overall_passed": true,  "phases": [/*...*/] },
    { "pass_index": 2, "dispatch_offset": 1, "overall_passed": false, "phases": [/*...*/] }
  ]
}
```

To localize a failure across passes, inspect `passes[].overall_passed` to find which pass surfaced the failure; each pass's `phases[]` carries the per-step replica assignment via `agent_index`.

## Limitations

- **No full-assessment mode.** `adcp storyboard run --url ... --url ...` requires a storyboard or bundle ID. The full capability-driven assessment path shares a single client across storyboards for connection reuse, which is incompatible with per-step URL dispatch. Run the bundles you care about individually.
- **Single auth across URLs.** `--auth` applies to every instance. Per-URL credentials for migration-era deployments with per-host tokens are not supported yet.
- **Sequential execution.** The runner does not parallelize steps across instances. It round-robins serially. Concurrent-write races are not exercised by this mode.
- **State sensitivity is inferred from step-level `stateful: true`.** The runner does not round-robin probe-only storyboards (e.g., `oauth_auth_server_metadata`) any differently than stateful ones — all steps are round-robined uniformly. For probes, every instance should return consistent metadata, which is its own valid invariant to check.

## Verify-by-architecture vs verify-by-multi-instance

The upstream docs ([Verifying cross-instance state](https://adcontextprotocol.org/docs/building/validate-your-agent#verifying-cross-instance-state)) call out three valid ways to prove the invariant. Multi-instance testing is one of them.

- **Verify by architecture.** If you deploy on a managed serverless platform with a shared datastore (Lambda + DynamoDB, Cloud Run + Firestore, Vercel + Neon, etc.), the invariant holds by construction. Single-URL storyboards that pass are sufficient — you do not need `--url` flags.
- **Verify by multi-instance testing.** If you deploy long-running processes, use `--url` to round-robin explicitly (this doc), OR stand up ≥2 replicas behind round-robin routing and run storyboards against the shared endpoint (the LB does the rotation).
- **Verify by your own testing.** Property-based tests, chaos fault injection, or production observability that correlates writes and reads across replicas are all valid. The protocol cares about the invariant, not the methodology.

## Related

- Spec requirement: [State persistence and horizontal scaling](https://adcontextprotocol.org/docs/protocol/architecture#state-persistence-and-horizontal-scaling)
- Builder guidance: [Verifying cross-instance state](https://adcontextprotocol.org/docs/building/validate-your-agent#verifying-cross-instance-state)
- Upstream PR: [adcontextprotocol/adcp#2363](https://github.com/adcontextprotocol/adcp/pull/2363)
- Client issue: [adcontextprotocol/adcp#2267](https://github.com/adcontextprotocol/adcp/issues/2267)
