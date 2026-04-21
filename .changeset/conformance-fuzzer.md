---
'@adcp/client': minor
---

Add `runConformance(agentUrl, opts)` — property-based fuzzing against an
agent's published JSON schemas, exposed as a new `@adcp/client/conformance`
subpath export so `fast-check` and the schema bundle stay off the runtime
client path. Closes #691.

Under the hood: `fast-check` arbitraries derived from the bundled draft-07
schemas at `schemas/cache/latest/bundled/`, paired with a two-path oracle
that classifies every response as **accepted** (validates the response
schema), **rejected** (well-formed AdCP error envelope with a spec-enum
reason code — the accepted rejection shape), or **invalid** (schema
mismatch, stack-trace leak, credential echo, lowercase reason code,
mutated context, or missing reason code). Responses that cleanly reject
unknown references count as passes, not failures.

Stateless tier covers 11 discovery tools across every protocol:
`get_products`, `list_creative_formats`, `list_creatives`,
`get_media_buys`, `get_signals`, `si_get_offering`,
`get_adcp_capabilities`, `tasks_list`, `list_property_lists`,
`list_content_standards`, `get_creative_features`. Self-contained-state
and referential-ID tiers are tracked for follow-up releases.

```ts
import { runConformance } from '@adcp/client/conformance';

const report = await runConformance('https://agent.example.com/mcp', {
  seed: 42,
  turnBudget: 50,
  authToken: process.env.AGENT_TOKEN,
});
if (report.totalFailures > 0) process.exit(1);
```

See `docs/guides/CONFORMANCE.md` for the full options reference.
