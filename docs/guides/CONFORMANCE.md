# Conformance Fuzzing

`@adcp/client/conformance` exports `runConformance(agentUrl, options)` —
property-based fuzzing against an agent's published JSON schemas.

## Why

A storyboard walks a golden path. A fuzzer walks the rejection surface.
Both matter. If your agent handles `get_signals({signal_spec: "auto"})`
correctly but crashes on `get_signals({signal_spec: ""})`, your
storyboard says pass and your users say outage.

`runConformance` generates schema-valid requests, calls your agent, and
classifies every response under a two-path oracle:

- **Accepted** — response validates against the response schema.
- **Rejected** — agent returned a well-formed AdCP error envelope with a
  spec-enum reason code. *This is a pass, not a failure* — unknown IDs
  *should* return `REFERENCE_NOT_FOUND`, not 500.
- **Invalid** — schema mismatch, stack trace in body, credential leak,
  missing reason code, lowercase reason code, context not echoed.

## Quickstart

```ts
import { runConformance } from '@adcp/client/conformance';

const report = await runConformance('https://agent.example.com/mcp', {
  seed: 42,
  turnBudget: 50, // iterations per tool
  protocol: 'mcp',
  authToken: process.env.AGENT_TOKEN,
});

if (report.totalFailures > 0) {
  console.error(JSON.stringify(report.failures, null, 2));
  process.exit(1);
}
```

## What's fuzzed

Stateless tier (no required entity IDs, no setup state):

| Tool | Protocol |
|---|---|
| `get_products` | media-buy |
| `list_creative_formats` | media-buy |
| `list_creatives` | creative |
| `get_media_buys` | media-buy |
| `get_signals` | signals |
| `si_get_offering` | sponsored-intelligence |
| `get_adcp_capabilities` | protocol |
| `tasks_list` | protocol |
| `list_property_lists` | property |
| `list_content_standards` | content-standards |
| `get_creative_features` | creative |

Stateful (sync → read back) and referential (generate_ids_from_fixtures)
tiers are tracked in adcontextprotocol/adcp-client#691 and will land in
subsequent releases.

## Interpreting failures

Every failure in the report carries the seed that reproduces it:

```json
{
  "tool": "get_signals",
  "seed": 1234567,
  "shrunk": true,
  "input": { "signal_spec": "" },
  "response": { "success": true, "data": { "signals": null } },
  "verdict": "invalid",
  "invariantFailures": [
    "response schema mismatch: /signals: must be array"
  ]
}
```

Re-run with the same seed to reproduce; fast-check's shrinker will have
already minimized `input` to the smallest request that reproduces the
failure.

## Options

- `seed` — integer, makes runs reproducible. Default: random.
- `tools` — subset of tools to fuzz. Default: all stateless tier.
- `turnBudget` — iterations per tool. Default: 50.
- `protocol` — `'mcp' | 'a2a'`. Default: `'mcp'`.
- `authToken` — Bearer token. The oracle also checks that the token never
  appears verbatim in any response body.
- `agentConfig` — overrides passed through to `AgentClient`
  (`name`, `id`, custom headers).

## Using it in CI

Add a conformance smoke as a separate workflow step so it runs on every
PR. Pass a fixed seed for reproducibility; rotate seeds weekly via a
nightly job to broaden coverage.

```yaml
- name: Conformance
  run: node scripts/conformance-smoke.js
  env:
    AGENT_URL: ${{ secrets.AGENT_URL }}
    AGENT_TOKEN: ${{ secrets.AGENT_TOKEN }}
```

## Not a replacement for

- **Storyboards** — narrative flow, multi-step sequences, async task
  lifecycle. Use `@adcp/client/testing` storyboard runners.
- **LLM red-team runner** — `adcp#2630`. Multi-step conversational
  fuzzing driven by an LLM.
- **Semantic validation** — budget math, referential integrity across
  plans. The fuzzer checks shape, not semantics.
