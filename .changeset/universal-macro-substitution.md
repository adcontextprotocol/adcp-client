---
"@adcp/sdk": minor
---

Add `expect_universal_macro_substituted` storyboard assertion and `universal_macro_translation` seller helper.

- `expect_universal_macro_substituted`: a self-contained storyboard assertion that verifies a seller substituted build-time-known identifiers (e.g. `{MEDIA_BUY_ID}`, `{PACKAGE_ID}`) with their real, runtime-captured values in a creative's rendered tracking URL. Reads the preview artifact from a prior step, aligns a macro template against observed tracker URLs via `SubstitutionObserver`, and neutral-skips (`no_preview_surface`) when no rendered output is observable.
- `universal_macro_translation(input_pixel_url, mapping)`: a producer helper that translates universal macros in a pixel URL's query parameters. `native` mappings are inserted raw (ad-server tokens); `value` mappings are RFC-3986 percent-encoded via the shared encoder; parameters whose universal macros are unmapped are dropped; already-minted parameters are left untouched.
- Fix the `SubstitutionObserver` HTML parser's residual-entity check so it no longer drops legitimate multi-parameter tracker URLs (the named-entity branch now requires a trailing semicolon, matching browser decoding), while preserving the scheme-smuggling defense.
