---
'@adcp/client': minor
---

Bump AdCP spec to 3.0.1; expose new sandbox conformance scenarios.

`ADCP_VERSION` advances from `3.0.0` to `3.0.1`. Per the spec release notes, 3.0.1 is a stable-surface no-op for 3.0-conformant agents — no wire-format changes, no field renames on stable schemas. Adopters whose handlers compile against 3.0.0 keep working unchanged.

**New test-controller scenarios** (sandbox-only, opt-in via store methods on `TestControllerStore`):

- `force_create_media_buy_arm` — register a directive shaping the next `create_media_buy` call from this authenticated sandbox account into the requested arm (`submitted` / `input-required`). Returns `ForcedDirectiveSuccess` with the registered arm + optional `task_id` echo. Implement `forceCreateMediaBuyArm({ arm, task_id?, message? })` to advertise.
- `force_task_completion` — transition an in-flight task to `completed` and record the supplied completion payload (delivered verbatim to the buyer's `push_notification_config.url`). Returns `StateTransitionSuccess`. Implement `forceTaskCompletion(taskId, result)` to advertise.
- `seed_creative_format` — pre-populate a creative-format fixture so storyboards can reference it by stable ID. Returns `StateTransitionSuccess` (`previous_state` / `current_state` per the existing seed envelope). Implement `seedCreativeFormat(formatId, fixture)` to advertise.

`expectControllerSuccess` now narrows on `'forced'` and `'seed'` kinds in addition to `'list' | 'transition' | 'simulation'`.

**Codegen rename — `FormatID` → `FormatReferenceStructuredObject`**: AdCP 3.0.1 changed the `format-id.json` schema title from `"Format ID"` to `"Format Reference (Structured Object)"` (purely documentation; wire shape is identical). The generated TypeScript type follows. The historical `FormatID` name remains exported as an alias from `@adcp/client` and `@adcp/client/types`, so consumer imports keep working across the bump.

**Inline-enum count drop** is expected — adcp#3148 + adcp#3174 hoisted ~20 byte-identical inline string-literal unions into shared `enums/*.json` files (e.g. `payment-terms`, `audio-channel-layout`, `match-type`, `governance-decision`). The corresponding per-parent `Foo_BarValues` exports collapse into single canonical names; `inline-enums.generated.ts` now ships 78 entries (was ~100).

**Bundler-side enum hoist** (adcp#3170) deduplicates the `Foo` / `Foo1` numbered-suffix codegen artifact at the bundle stage. `core.generated.ts` no longer ships `AgeVerificationMethod1` and similar duplicates.
