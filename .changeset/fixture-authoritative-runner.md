---
'@adcp/client': minor
---

Storyboard runner: fixture-authoritative request construction (closes #820).

The runner's request-construction priority is inverted. `sample_request`
is now the authoritative base payload — when authored, every top-level
key the author wrote reaches the wire verbatim. The per-task enricher
(formerly "request builder") runs alongside, filling fields the fixture
left unset — typically discovery-derived identifiers, envelope fields,
or context-substituted placeholders.

The previous behavior silently fabricated payloads and discarded author
fixtures on ~20 tasks whose enrichers didn't opt into a fixture-honoring
early return. That false-green failure mode produced five consecutive
fallback-shape bugs (#780 / #792 / #793 / #802 / #805) before anyone
noticed the architecture was backward.

### New contract

- **`sample_request` (authored)** — base payload. Context placeholders
  (`$context.*`, `$generate:uuid_v4`, `{{runner.*}}`) resolve as before.
- **Enricher (per-task)** — produces fields that gap-fill the fixture.
  Fixture wins every top-level conflict.
- **Fixture-aware enrichers** (`create_media_buy`, `comply_test_controller`) —
  declared in `FIXTURE_AWARE_ENRICHERS` because they splice
  discovery-derived fields INTO nested fixture structures (array-level
  merges the generic overlay can't express). The runner passes their
  output verbatim; envelope fields from the fixture (`context`, `ext`,
  `push_notification_config`, `idempotency_key`) still flow through.

### Load-time hard-fail

Mutating tasks (per `MUTATING_TASKS`) now throw at storyboard load when
`sample_request` is absent and `expect_error !== true`. The runner no
longer fabricates write payloads. Error messages point at the task,
step id, storyboard id, and suggest the concrete author action. Synthesized
phases (request-signing, controller seeding) are unaffected — their
runtime-generated steps don't pass through `parseStoryboard`.

### Rename (compat preserved)

- `buildRequest` → `enrichRequest` (old name kept as deprecated alias)
- `hasRequestBuilder` → `hasRequestEnricher` (old name kept)
- `REQUEST_BUILDERS` → `REQUEST_ENRICHERS` (internal)

External consumers pinned to the old names continue to work for one
release. Migrate to the new names at your own pace.

### Observable-behavior changes

- Mutating storyboards that omitted `sample_request` fail loudly at load
  instead of silently shipping fabricated payloads. This is the
  intentional correctness improvement.
- **Fixture `account` now wins** on four tasks whose pre-inversion
  builders injected `context.account` OVER the fixture's authored
  `account` via the hybrid `{ ...sample_request, account: context.account }`
  pattern: `sync_catalogs`, `sync_creatives`, `report_usage`,
  `sync_audiences`. Storyboards that relied on the runner silently
  substituting `context.account` over their authored value will now send
  the authored value. Audit these fixtures if your tests depend on a
  specific account on these tasks.
- Under fixture-wins merge, options-derived fields (e.g.
  `options.brief` → `signal_spec`) now coexist with authored fields
  (`sample_request.signal_ids`) instead of replacing them. A storyboard
  authoring signal_ids and being invoked with `--brief X` now sends
  both; agents receive a richer query. Schema-valid under
  `anyOf: [signal_spec | signal_ids]`.
- Enricher-derived identity fields (e.g. `get_rights.brand_id` from
  `resolveBrand(options)`) gap-fill when fixture omits them. A
  storyboard that specifically needs an identity field absent must
  author it explicitly or opt out via `expect_error: true`.

Strict-vs-lenient run reporting (the fourth proposal in #820) is
deferred to a separate issue — it's a reporting-subsystem concern
orthogonal to the request-construction flow.
