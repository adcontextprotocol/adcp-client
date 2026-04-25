---
"@adcp/client": patch
---

Skill drift fixes (caught by `npm run typecheck:skill-examples`):

- 8 SKILL.md files imported `verifyApiKey`, `verifyBearer`, `anyOf`, `bridgeFromTestControllerStore` from `@adcp/client` (top-level) — these symbols only exist under `@adcp/client/server`. Agents copy-pasting the example would get `Module has no exported member` at compile time. Fixed across all affected skills (`build-creative-agent`, `build-generative-seller-agent`, `build-governance-agent`, `build-retail-media-agent`, `build-seller-agent`, `build-si-agent`, `build-signals-agent`, `build-seller-agent/deployment.md`).

Plus `scripts/typecheck-skill-examples.ts` — extracts every fenced TS block from `skills/**/*.md`, compiles each as a standalone module against the published `@adcp/client` types, and fails on new typecheck errors. Baseline mode (`scripts/skill-examples.baseline.json`) records the 142 known documentation-pattern errors (placeholder identifiers, untyped `ctx.store.list` returns) so the script ships green on day one and ratchets down over time. Run with `npm run typecheck:skill-examples`.
