---
"@adcp/sdk": patch
---

Add audio creative-template support to the mock-server and hello adapter (Path 3 from the PR #1496 follow-up).

The fork-matrix collapse claimed audio creative-template patterns but didn't ship runnable code for them. This patch fills that gap end-to-end without forking a separate adapter:

- `src/lib/mock-server/creative-template/seed-data.ts` — extended `output_kind` union with `'audio_url'`; seeded `tpl_audiostack_spot_30s_v1` modeling the TTS / mix / master pipeline (text script → optional voice + music_bed → 30s mastered MP3). No dimensions; the existing `queued → running → complete` state machine already simulates the multi-minute render time real audio platforms (AudioStack, ElevenLabs, Resemble) take.
- `src/lib/mock-server/creative-template/server.ts` — added an `audio_url` branch to `synthesizeOutput` that returns `{ audio_url: '<previewBase>.mp3', preview_url, assets: [{ kind: 'audio_url', mime_type: 'audio/mpeg' }] }`.
- `examples/hello_creative_adapter_template.ts` — extended `UpstreamTemplate.output_kind` and `UpstreamRender.output` to include the audio shape; added `else if (out.audio_url)` branch in `projectRenderToManifest` that wraps the URL with `audioAsset({ url })` (the framework injects the `asset_type: 'audio'` discriminator into the creative-manifest oneOf).
- `skills/build-creative-agent/SKILL.md` — replaced the "audio templates" paragraph with a worked-reference one citing the seeded audio template plus the `audioAsset()` projection. Notes that storyboard coverage for audio is not yet upstream (filed as adcontextprotocol/adcp#4015).

Adopters integrating an audio creative platform now have a runnable round-trip path from `npx adcp mock-server creative-template` through the adapter to a complete creative-manifest with an audio asset. Validated via:

```ts
const handle = await bootMockServer({ specialism: 'creative-template', port: 0 });
const r = await fetch(handle.url + '/v3/workspaces/ws_acme_studio/renders', {
  method: 'POST',
  body: JSON.stringify({ template_id: 'tpl_audiostack_spot_30s_v1', mode: 'build', inputs: [{ slot_id: 'script', value: '...' }], client_request_id: '1' })
});
// queued → running → complete with { audio_url, preview_url, assets: [{ kind: 'audio_url' }] }
```

Storyboard-grader coverage for audio is tracked at adcontextprotocol/adcp#4015 — the existing `creative_template` storyboard's `build_creative` step is hardcoded to display assets (image + headline + click_url), so audio adopters can't pass it today. Until that ships, audio adopters validate via `npm run compliance:fork-matrix -- --test-name-pattern="hello-creative-adapter-template"` (display + video gate inherited) plus the manual round-trip above.

Pure additive — no breaking changes. Existing display + video templates unchanged; fork-matrix 23/23 still green.
