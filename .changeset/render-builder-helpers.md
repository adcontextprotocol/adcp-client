---
'@adcp/client': minor
---

Add typed factory helpers for `preview_creative` render objects: `urlRender`, `htmlRender`, `bothRender`, plus a grouped `Render` namespace. Each helper takes the render payload without `output_format` and returns an object tagged with the canonical discriminator — `urlRender({ render_id, preview_url, role })` produces a valid url-variant render without repeating `output_format: 'url'` at every call site.

Mirrors the `imageAsset` / `videoAsset` pattern shipped in #771. `PreviewRender` is a oneOf on `output_format` (`url` / `html` / `both`) where the discriminator decides which sibling field becomes required. Matrix runs consistently surfaced renders missing either `output_format` or its required sibling — the helpers make the wrong shape syntactically harder to express because the input type requires the matching `preview_url` / `preview_html` per variant.

Return type uses `Omit<Variant, 'output_format'> & { output_format: <literal> }` so the builders stay robust across schema regenerations. Discriminator is spread last so a runtime cast cannot overwrite the canonical tag.

Skill pitfall callouts in `build-creative-agent` and `build-generative-seller-agent` now recommend the render helpers alongside the asset helpers.
