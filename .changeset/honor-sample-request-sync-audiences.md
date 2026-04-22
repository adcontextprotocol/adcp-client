---
'@adcp/client': patch
---

fix(testing): honor `step.sample_request` on add-shaped payloads in storyboard `sync_audiences` builder

The storyboard request builder for `sync_audiences` only delegated to `step.sample_request` for delete or discovery shapes. Add-shaped payloads — where a storyboard authors `audience_id` with `add: [...]` identifiers — fell through to the generated fallback, which overwrote the authored id with `test-audience-${Date.now()}`. Downstream steps that referenced the authored id (e.g., `delete_audience` in the `audience_sync` specialism, or `$context.audience_id` substitutions) then hit `AUDIENCE_NOT_FOUND` because sync had registered a different id.

The builder now delegates to `step.sample_request` whenever it's present (matching `sync_event_sources`, `sync_catalogs`, `sync_creatives`, and peers), falling back to the generated payload only when no `sample_request` is authored.
