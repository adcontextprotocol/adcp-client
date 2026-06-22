---
"@adcp/sdk": minor
---

Add `translateUniversalMacros` seller helper and fix a `SubstitutionObserver` parser false-positive.

- `translateUniversalMacros(input_pixel_url, mapping)`: a producer helper that translates universal macros in a pixel URL's query-parameter values. `native` mappings are inserted raw (ad-server tokens); `value` mappings are RFC-3986 percent-encoded via the shared encoder; parameters whose universal macros are unmapped are dropped (recorded in `dropped_params` / `unmapped_macros`); already-minted parameters are left untouched. Dropped consent/privacy macros are surfaced separately in `dropped_consent_macros` so a forgotten-mapping drop isn't lost among benign drops. The result also reports `suspect_native_values` — macros whose `value` entry looks like a native ad-server token (`%%…%%`, `{{…}}`, `${…}`, `[UPPER_SNAKE]`) and was likely mapped to the wrong arm. Macros in key position are not translated.
- Fix the `SubstitutionObserver` HTML parser's residual-entity check so it no longer drops legitimate multi-parameter tracker URLs (the named-entity branch now requires a trailing semicolon, matching browser decoding), while preserving the scheme-smuggling defense.
