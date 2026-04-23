---
'@adcp/client': patch
---

docs(creative-agent): louder build_creative response-shape callouts, add audio creative-template example

Makes discoverability of existing SDK surface better for creative agents:

- `docs/llms.txt` — new "Watch out:" blocks on `build_creative`, `preview_creative`, and `list_creative_formats` that point at `buildCreativeResponse`/`buildCreativeMultiResponse`/typed asset factories and flag the audio-formats `renders` gotcha. Driven by a data map in `scripts/generate-agent-docs.ts`.
- `skills/build-creative-agent/SKILL.md` — cross-cutting pitfalls now mention `audioAsset` and spell out that platform-native top-level fields (`tag_url`, `creative_id`, `media_type`) are invalid responses. Adds an Audio subsection under `creative-template` covering format declaration (`type: 'audio'`, `renders: [{ role, duration_seconds }]`), async render pipelines, and a handler example using `buildCreativeResponse` + `audioAsset`.

No library code changes — the factories and response helpers already shipped in prior releases.
