---
'@adcp/client': patch
---

Request-signing grader — two follow-ups from the #617 review thread.

**Operation-name allowlist** in `extractOperationFromVectorUrl`. Previously
the extractor returned whatever URL-decoded bytes sat in the vector URL's
last path segment and inlined that into `params.name`. AdCP operations are
spec-defined identifiers (lowercase snake_case matching
`static/schemas/source/enums/operation.json`); constrain the extractor
output to `/^[a-z][a-z0-9_]*$/` so a corrupted compliance cache can't
smuggle arbitrary bytes into the JSON-RPC envelope. No exploit today —
fixtures are spec-published, not attacker-supplied — but defense in depth.

**MCP rate-abuse subtest** in `test/request-signing-grader-mcp.test.js`.
Spins up a dedicated MCP agent with `ADCP_REPLAY_CAP=10` + grades with
`onlyVectors: ['020-rate-abuse']`, `rateAbuseCap: 10`,
`allowLiveSideEffects: true`. Exercises the end-to-end rate-abuse flow
under MCP transport (previously only covered against the raw-HTTP
reference verifier). Adds `ADCP_REPLAY_CAP` env override to
`test-agents/seller-agent-signed-mcp.ts` so tests can tune the cap
without forking the agent.
