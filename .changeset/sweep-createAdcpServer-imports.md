---
'@adcp/sdk': patch
---

Repo-wide sweep of `createAdcpServer` imports after the v6.0 breaking change. Every adopter-facing surface (skills, docs, examples, test agents) now points at `@adcp/sdk/server/legacy/v5` (the only path that still exports it) and every internal JSDoc `@example` shows the same path so IDE hover help stays correct.

- 5 docs (`docs/guides/BUILD-AN-AGENT.md`, `CONCURRENCY.md`, `VALIDATE-LOCALLY.md`, `VALIDATE-YOUR-AGENT.md`, `docs/llms.txt`)
- 3 skill files (`skills/build-brand-rights-agent/SKILL.md`, `skills/build-seller-agent/deployment.md`, `skills/build-si-agent/SKILL.md`)
- 1 migration doc (`docs/migration-5.x-to-6.x.md`) — updated to reflect the actual hard-removal (was previously documented as `@deprecated` deferred-removal)
- 9 internal JSDoc blocks across `src/lib/server/*` and `src/lib/schemas/index.ts` / `src/lib/compliance-fixtures/index.ts`
- 3 examples + test agents (`examples/signals-agent.ts`, `test-agents/seller-agent.ts`, `test-agents/seller-agent-signed-mcp.ts`, `test-agents/signals-agent.ts`)
- 1 matrix harness prompt (`scripts/manual-testing/agent-skill-storyboard.ts`) — now lets the skill drive the import path instead of forcing a single broken one
- 1 tsconfig update (`test-agents/tsconfig.json`) — added subpath aliases for `@adcp/sdk/server`, `@adcp/sdk/server/legacy/v5`, `@adcp/sdk/signing` so local typecheck resolves the new paths

Test-agents typecheck clean. 888/888 server tests pass.
