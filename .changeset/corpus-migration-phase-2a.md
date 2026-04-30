---
'@adcp/sdk': patch
---

docs: corpus migration phase 2A — seller skill deep-block migration + .claude mirror surface migration

Continues #1088 corpus migration. Phase 2A delivers:

- **`skills/build-seller-agent/SKILL.md` deep blocks fully migrated** to v6 — all 5 v5 code examples (signed-requests resolveIdempotencyPrincipal, webhook emission, bridgeFromTestControllerStore, full Implementation worked example, HITL with `taskToolResponse`) are now `class MyClass implements DecisioningPlatform<>` with `createAdcpServerFromPlatform(...)`. Only 3 `createAdcpServer` mentions remain — all intentional callouts to the `@adcp/sdk/server/legacy/v5` subpath.
- **`.claude/skills/build-seller-agent/SKILL.md` mirror surface migration** — Quick Reference table, Implementation prose (with LEGACY callout pointing at the canonical v6 in `skills/build-seller-agent/`), Common Mistakes table, Idempotency wire-up prose, Production-wiring LEGACY callout, cross-references all updated. The deep code blocks remain at v5 with LEGACY callouts (phase 2B).
- **typecheck-skill-examples baseline updated** to absorb new illustrative-only blocks.

Phase 2B (still on #1088) covers the remaining sibling skills (governance, generative-seller, retail-media, signals, si, creative), `BUILD-AN-AGENT.md`, and the .claude mirror's deep code blocks. **Subagent attempt blocked**: 5 parallel docs-expert agents all hit `Edit/Write permission denied` from the harness sandbox; phase 2B needs an unsandboxed session OR sandbox config update.

Refs #1088.
