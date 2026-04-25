---
"@adcp/client": patch
---

Skill drift fixes surfaced by matrix conformance harness:

- **build-creative-agent**: replace non-existent `server.registerTool('preview_creative', ...)` with the `creative.previewCreative` domain handler that has existed since `createAdcpServer` first shipped. Agents following the previous skill text wrote `TypeError: server.registerTool is not a function` into `serve()`, the factory threw, no tools registered, and the agent returned 401 on every request.
- **build-creative-agent**: vendor-pricing pitfall added — `list_creatives.creatives[].pricing_options[]` uses field name `model` (not `pricing_model` like products), and each model has its own required fields. Includes the `flat_fee` `period` requirement that the schema enforces but earlier skill text omitted.
- **All skills**: cross-cutting pitfall callout — `capabilities.specialisms` on `createAdcpServer` is required for storyboard track resolution. Agents that wire every tool but don't claim their specialism fail conformance with "No applicable tracks found" silently.
- **build-seller-agent**: split into `SKILL.md` (95 KB, was 136 KB) plus `deployment.md` and 6 specialism-delta files under `specialisms/`. Reduces the single-file budget Claude has to process when building a sales-non-guaranteed agent.
- **build-brand-rights-agent / build-generative-seller-agent / build-governance-agent / build-retail-media-agent**: `sync_accounts` response per-row `action` field clarified (`'created' | 'updated' | 'unchanged' | 'failed'` enum required by schema; previously skill examples omitted it).

Plus `scripts/conformance-replay.ts` — deterministic in-process schema-conformance harness covering creative-template (6/6 steps pass in ~2s). Not user-facing; ships in the published package because `scripts/**` is published. v0; expansion to other specialisms in follow-ups.
