---
'@adcp/client': minor
---

Storyboard runner: `--multi-instance` mode to catch horizontal-scaling persistence bugs.

A seller deployed behind a load balancer with in-memory state passes every storyboard against a single URL but breaks in production when a follow-up step lands on a different machine. Single-URL runs never exercise this. `runStoryboard` now accepts an array of agent URLs and round-robins steps across them — writes on instance A must be visible on instance B or the read fails, and the runner attributes the failure with an instance→step map and a `write on [#A] → read on [#B] → NOT_FOUND` signature line matching the canonical horizontal-scaling bug.

CLI:

```
npx @adcp/client storyboard run \
  --url https://a.your-agent.example/mcp/ \
  --url https://b.your-agent.example/mcp/ \
  account_and_audience \
  --auth $TOKEN
```

- Repeated `--url` engages multi-instance mode (minimum 2). Positional agent is disallowed in this mode — single-URL runs still use the positional shorthand.
- JSON output gains `agent_urls[]` and `multi_instance_strategy` on the result, and `agent_url` + `agent_index` on each step.
- `--dry-run` prints the per-step instance assignment plan.
- Full capability-driven assessment (no storyboard ID) is not yet multi-instance aware; use a specific storyboard or bundle ID.

Error output mirrors the canonical failure example in the protocol docs (`create on replica [#1] … succeeded. read on replica [#2] … failed with NOT_FOUND. → Brand-scoped state is not shared across replicas.`) so developers pattern-match the page they'll click through to. Deep-links to [Verifying cross-instance state](https://adcontextprotocol.org/docs/building/validate-your-agent#verifying-cross-instance-state).

See `docs/guides/MULTI-INSTANCE-TESTING.md` for the full contract, including why the test asserts `(brand, account)`-keyed state, when false failures can occur, and how this fits alongside verify-by-architecture and verify-by-own-testing approaches.

Implements the client-side half of the cross-instance persistence requirement introduced in [adcontextprotocol/adcp#2363](https://github.com/adcontextprotocol/adcp/pull/2363). Closes [adcontextprotocol/adcp#2267](https://github.com/adcontextprotocol/adcp/issues/2267).
