---
"@adcp/client": minor
---

Storyboard runner: add `$generate:opaque_id` substitution and `context_outputs[generate]` for threading runner-minted task IDs through multi-step lifecycle storyboards.

`$generate:opaque_id` and `$generate:opaque_id#<alias>` work identically to `$generate:uuid_v4` / `$generate:uuid_v4#<alias>` but carry explicit task-ID semantics. Both share the same alias cache namespace.

`context_outputs` entries now accept `generate: "opaque_id" | "uuid_v4"` as an alternative to `path:`. When `generate` is set the runner mints (or reuses, via alias-cache coherence) a UUID at post-step time and writes it into `$context.<key>` for subsequent steps. If an inline `$generate:opaque_id#<key>` substitution already ran in the same step's `sample_request`, the generator reuses that value — the two forms are alias-coherent.

`ContextProvenanceEntry.source_kind` and `ContextValueRejectedHint.source_kind` gain a `'generator'` variant for accurate diagnostic attribution. `ContextOutput.path` is now optional (mutually exclusive with the new `generate` field).
