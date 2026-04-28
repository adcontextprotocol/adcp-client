---
'@adcp/client': minor
---

Bump AdCP spec to 3.0.1; expose new sandbox conformance scenarios.

`ADCP_VERSION` advances from `3.0.0` to `3.0.1`. Per the spec release notes, 3.0.1 is a stable-surface no-op for 3.0-conformant agents — no wire-format changes, no field renames on stable schemas. Adopters whose handlers compile against 3.0.0 keep working unchanged.

**New test-controller scenarios** (sandbox-only, opt-in via store methods on `TestControllerStore`). Sellers wanting compliance coverage for the AdCP 3.0.1 submitted-arm storyboard, async task completion path, or creative-format storyboards opt in by implementing the matching method — no breaking change for existing stores:

- `force_create_media_buy_arm` — register a directive shaping the next `create_media_buy` call from this authenticated sandbox account into the requested arm (`submitted` / `input-required`). Returns `ForcedDirectiveSuccess` with the registered arm + optional `task_id` echo. Implement `forceCreateMediaBuyArm({ arm, task_id?, message? })` to advertise. Param validation rejects `task_id` on the `input-required` arm (spec: present only when `submitted`).
- `force_task_completion` — transition an in-flight task to `completed` and record the supplied completion payload (delivered verbatim to the buyer's `push_notification_config.url`). Returns `StateTransitionSuccess`. Implement `forceTaskCompletion(taskId, result)` to advertise. Param validation rejects array values for `result` (spec: object that validates against `async-response-data.json`).
- `seed_creative_format` — pre-populate a creative-format fixture so storyboards can reference it by stable ID. Returns `StateTransitionSuccess` (`previous_state` / `current_state` per the existing seed envelope). Implement `seedCreativeFormat(formatId, fixture)` to advertise.

`expectControllerSuccess` now narrows on `'forced'` and `'seed'` kinds in addition to `'list' | 'transition' | 'simulation'`. The `'seed'` overload is in place for inter-op with sellers that emit the new `SeedSuccess` arm; the SDK's own `dispatchSeed` continues to return `StateTransitionSuccess` (a follow-up will migrate it).

**Codegen rename — `FormatID` → `FormatReferenceStructuredObject`**: AdCP 3.0.1 changed the `format-id.json` schema title from `"Format ID"` to `"Format Reference (Structured Object)"` (purely documentation; wire shape is identical). The generated TypeScript type follows. The historical `FormatID` name remains exported as an `@deprecated` alias from `@adcp/client` and `@adcp/client/types`, so consumer imports keep working across the bump while editor tooling surfaces the rename. Slated for removal in the next major.

**Codegen rename — `RATE_LIMITEDDetails` → `RateLimitedDetails`**: 3.0.1 added an explicit `title` to the rate-limited error-details schema so `json-schema-to-typescript` produces PascalCase. The previously-shipped `RATE_LIMITEDDetails_ScopeValues` export is preserved as `@deprecated` pointing at the canonical `RateLimitedDetails_ScopeValues`.

**Inline-enum count drop** is expected — adcp#3148 + adcp#3174 hoisted ~20 byte-identical inline string-literal unions into shared `enums/*.json` files (e.g. `payment-terms`, `audio-channel-layout`, `match-type`, `governance-decision`). The corresponding per-parent `Foo_BarValues` exports collapse into single canonical names (`PaymentTermsValues`, `AudioChannelLayoutValues`, `MatchTypeValues`, `GovernanceDecisionValues`, …); `inline-enums.generated.ts` now ships 78 entries (was ~100).

**Back-compat aliases for the 26 collapsed/renamed `Foo_BarValues` exports** ship in `@adcp/client/types` for one minor cycle so existing consumer imports keep compiling. Each is `@deprecated` with a JSDoc pointing at the canonical name. Slated for removal in the next major.

**Bundler-side enum hoist** (adcp#3170) deduplicates the `Foo` / `Foo1` numbered-suffix codegen artifact at the bundle stage. `core.generated.ts` no longer ships `AgeVerificationMethod1` and similar duplicates.
