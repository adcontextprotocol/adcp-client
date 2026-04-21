---
'@adcp/client': patch
---

Adds `docs/guides/VALIDATE-YOUR-AGENT.md` — the operator-facing checklist covering `adcp storyboard run`, `adcp fuzz` (Tier 1/2/3), `adcp grade request-signing`, multi-instance testing, `--webhook-receiver`, schema-driven validation hooks, custom `--invariants`, and `SubstitutionEncoder`/`Observer`. Cross-linked from `BUILD-AN-AGENT.md` and the repo `CLAUDE.md`.

Ships `npm run compliance:skill-matrix` (new `scripts/manual-testing/run-skill-matrix.ts` driver + `skill-matrix.json`) which fans the existing `agent-skill-storyboard.ts` harness across skill × storyboard pairs with `--filter`, `--parallel`, and `--stop-on-first-fail`.

Every `skills/build-*-agent/SKILL.md` replaces its ad-hoc `## Validation` section with a uniform `## Validate Locally` block: canonical storyboard IDs, cross-cutting bundles (`security_baseline,idempotency,schema_validation,error_compliance`), `adcp fuzz` with per-specialism `--tools`, per-specialism failure decoder, and a pointer back to the operator checklist. `build-retail-media-agent/SKILL.md` gains `SubstitutionEncoder.encode_for_url_context` wiring guidance for catalog-driven macro URLs.
