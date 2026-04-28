# Conformance Fuzzing

`@adcp/sdk/conformance` exports `runConformance(agentUrl, options)` —
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
- **Invalid** — schema mismatch, stack trace in body (V8 / Node,
  Python, Go, JVM, PHP, .NET), credential leak, missing reason code,
  lowercase reason code, context not echoed when the response schema
  declares a `context` property.

## Quickstart

```ts
import { runConformance } from '@adcp/sdk/conformance';

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
adcp fuzz <url> --auto-seed
adcp fuzz --list-tools
```

The CLI exits 1 on any failure, 0 on clean. Use `--format json` for CI
consumers that want the structured report.

## Auto-seed (Tier 3)

Passing `autoSeed: true` (or `--auto-seed` on the CLI) tells
`runConformance` to bootstrap real agent state before fuzzing:

```ts
await runConformance(url, { autoSeed: true, ... });
```

The seeder calls `create_property_list`, `create_content_standards`,
(via a `get_products` preflight) `create_media_buy`, and (via a
`list_creative_formats` preflight) `sync_creatives` against the agent,
captures the returned IDs, and merges them into `options.fixtures`
before the fuzz loop starts. Tier-3 update tools (`update_media_buy`,
`update_property_list`, `update_content_standards`) are added to the
default tool list automatically — they're no-ops against random IDs, so
they only run when real IDs are available.

For the creative seeder, the helper picks the first format whose
required assets are all of a "simple" type (image, video, audio, text,
url, html, javascript, css, markdown) and synthesizes placeholder
values. Formats requiring VAST/DAAST/custom assets are skipped with a
warning; supply `--fixture creative_ids=...` explicitly if you need
creative coverage on an exotic-format-only agent.

### Brand allowlists

Mutating seeders (`create_media_buy`, `sync_creatives`) need a brand
reference. Default is `{ domain: 'conformance.example' }`. Sellers that
enforce brand allowlists will reject this and the pipeline falls through
to a warning. Override with:

```ts
runConformance(url, { autoSeed: true, seedBrand: { domain: 'my-sandbox.example' } });
```

Or on the CLI: `--seed-brand my-sandbox.example`.

The seeder is best-effort: a rejection from any seeder becomes a
`report.seedWarnings` entry and the pool stays empty for that key. The
fuzzer continues with whatever it got.

**⚠️  Auto-seed mutates agent state.** Point at a sandbox / test tenant —
the fuzzer will create artifacts that the agent owns. There is no
teardown; seeded rows stay until the agent's own lifecycle reclaims
them.

**Reproduction note**: when a Tier-3 failure is reported, the
reproduction hint echoes `--auto-seed`. Seeded IDs are agent-generated
and differ per run — so most of the time a fresh seed + the same
`--seed --tools T --auto-seed` reproduces. If the failure was shape-
specific to the original ID (e.g., fast-check's generator path changed
because the pool changed), the report prints a `pin: --fixture ...`
line with the IDs captured at failure time so you can replay against
the exact pool.

**Brand-allowlist gotcha**: mutating seeders use
`brand.domain: 'conformance.example'` as a placeholder. Sellers that
enforce brand allowlists will reject this; the pipeline degrades to a
warning and the affected pool stays empty. Override with `--seed-brand`
or supply your own IDs via `--fixture media_buy_ids=...` etc.

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
| `standards_ids` | `standards_id`, `standards_ids` |

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
  lifecycle. Use `@adcp/sdk/testing` storyboard runners.
- **LLM red-team runner** — `adcp#2630`. Multi-step conversational
  fuzzing driven by an LLM.
- **Semantic validation** — budget math, referential integrity across
  plans. The fuzzer checks shape, not semantics.
