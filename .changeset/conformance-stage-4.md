---
'@adcp/client': minor
---

Conformance fuzzer Stage 4 — creative seeding, configurable brand,
broader stack-trace detection, additionalProperties probing, and stricter
context-echo enforcement.

**Coverage (A)**

- **`sync_creatives` auto-seeder**: preflights `list_creative_formats`,
  picks the first format whose required assets are all of a simple type
  (image, video, audio, text, url, html, javascript, css, markdown),
  synthesizes placeholder values, and captures `creative_id`s from the
  response. Now runs as part of `seedFixtures` / `autoSeed`.
- **`seedBrand` option** + **`--seed-brand <domain>`** CLI flag: overrides
  the mutating-seeder brand reference. Defaults to
  `{ domain: 'conformance.example' }`, which sellers with brand
  allowlists reject. Configurable per run.

**Oracle (D)**

- **JVM + .NET stack-trace signatures**: `at com.foo.Bar.method(Bar.java:42)`
  and `at Foo.Bar() in X.cs:line 42` shapes detected alongside the
  existing V8/Python/Go/PHP patterns.
- **additionalProperties injection**: when a schema permits extra keys
  (`additionalProperties: true`), the generator sometimes injects one
  (~15% frequency, single extra key from a fixed vocabulary). Exercises
  the unknown-field tolerance surface — a common crash source where
  agents deserialize into strict structs and reject unexpected keys.
- **Stricter context-echo**: when a response schema declares a
  top-level `context` property, dropping it entirely is now an invariant
  violation. Silent tolerance preserved for tools whose response schema
  omits the field.

New public exports: extended `SeederName` with `'sync_creatives'`,
`SeedOptions.brand`, `RunConformanceOptions.seedBrand`.
