---
'@adcp/client': patch
---

chore: regenerate types from latest AdCP schema tarball

Routine type regen after upstream schema sync. Unblocks matrix v12 — CI's
"Validate generated files" fails on any branch with stale generated types,
so landing this before the matrix keeps the failing-pair baseline clean.

Notable wire-level changes picked up from upstream:

- `si_initiate_session` renames `context: string` → `intent: string` and
  introduces `context?: ContextObject` as a separate structured field.
- `sync_creatives` response items now require `action` (lifecycle
  discriminator: `created` / `updated` / `failed` / `deleted`).
- Creative assets adopt an `asset_type` discriminator on every value under
  `creative_manifest.assets` (`image`, `video`, `audio`, `text`, `url`,
  `html`, `javascript`, `css`, `markdown`, etc.).

Conformance seeder placeholders (`src/lib/conformance/seeder.ts`) are
updated to emit the required `asset_type` discriminator so seeded creatives
pass the new strict-response validation surface introduced in #757.
