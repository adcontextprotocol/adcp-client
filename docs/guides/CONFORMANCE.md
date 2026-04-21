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

## CLI

```
adcp fuzz https://agent.example.com/mcp --seed 42 --turn-budget 50
adcp fuzz <url> --tools get_signals,get_products --format json | jq
adcp fuzz <url> --fixture creative_ids=cre_a,cre_b
adcp fuzz --list-tools
```

The CLI exits 1 on any failure, 0 on clean. Use `--format json` for CI
consumers that want the structured report.

## What's fuzzed

**Stateless tier** — no required entity IDs, no setup state:

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

**Referential tier** — take an ID but no setup. Without fixtures, random
IDs exercise only the rejection surface (agents MUST return
`REFERENCE_NOT_FOUND`, not 500). With fixtures, the arbitrary draws IDs
from the supplied pools to exercise the accepted path.

| Tool | Protocol |
|---|---|
| `get_media_buy_delivery` | media-buy |
| `get_property_list` | property |
| `get_content_standards` | content-standards |
| `get_creative_delivery` | creative |
| `tasks_get` | protocol |
| `preview_creative` | creative |

## Fixtures (Tier 2)

Pre-seed ID pools to test the accepted path on referential tools:

```ts
await runConformance(url, {
  fixtures: {
    creative_ids: ['cre_abc', 'cre_def'],
    media_buy_ids: ['mb_123'],
    list_ids: ['pl_789'],
  },
});
```

The arbitrary generator inspects each property name in a request schema
and swaps `fc.constantFrom(pool)` for random strings when it finds a
match. Supported pools (mapped by property name):

| Pool | Property names matched |
|---|---|
| `creative_ids` | `creative_id`, `creative_ids` |
| `media_buy_ids` | `media_buy_id`, `media_buy_ids` |
| `list_ids` | `list_id`, `list_ids` |
| `task_ids` | `task_id`, `taskId` |
| `plan_ids` | `plan_id` |
| `account_ids` | `account_id` |
| `package_ids` | `package_id`, `package_ids` |

Stateful Tier 3 (full `sync_creatives` → read-back flow driven by the
runner itself) is tracked in adcontextprotocol/adcp-client#698.

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
