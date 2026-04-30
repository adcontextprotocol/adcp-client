---
'@adcp/sdk': patch
---

docs: corpus migration phase 1 — seller skill v5 → v6 prose + canonical example

Migrates the highest-LLM-target file (`skills/build-seller-agent/SKILL.md`) from v5 `createAdcpServer` patterns to v6 `createAdcpServerFromPlatform`. Phase 1 covers:

- Canonical opening platform skeleton (replaces the v5 handler-bag example with a typed `DecisioningPlatform<TConfig, TCtxMeta>` class)
- SDK Quick Reference table (v6 first; v5 marked legacy + pointing at `@adcp/sdk/server/legacy/v5`)
- Common Mistakes table (call out v5-in-new-code as a misuse)
- 13 narrative prose mentions (idempotency, webhooks, context echo, response builders, generics, cross-refs)

Phase 2 (tracked separately on #1088) covers the deeper code-block rewrites in this file (~6 multi-line examples) plus the other 8 skill files, `BUILD-AN-AGENT.md`, and the `.claude/skills/` mirror.

Closes part of #1088 (phase 1 only).
