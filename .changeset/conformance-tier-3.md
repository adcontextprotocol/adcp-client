---
'@adcp/client': minor
---

Conformance fuzzer Tier 3 — auto-seeding + update-tool fuzzing.

- **`seedFixtures(agentUrl, opts)`** helper — creates a property list,
  a content-standards config, and (after a `get_products` preflight) a
  media buy on the agent, captures the returned IDs, and returns a
  `ConformanceFixtures` bag ready to pass to `runConformance`. Each
  seeder is best-effort: failures degrade to a recorded warning and an
  empty pool, never a thrown exception.
- **`runConformance({ autoSeed: true })`** — runs the seeder first,
  merges results into `options.fixtures` (explicit fixtures win on
  conflict), and includes Tier-3 update tools (`update_media_buy`,
  `update_property_list`, `update_content_standards`) in the default
  tool list. The report carries `autoSeeded: boolean` and a
  `seedWarnings` array.
- **`adcp fuzz --auto-seed`** CLI flag. `--list-tools` now marks
  Tier-3 tools with `(update — needs --auto-seed or --fixture)`. The
  human-readable report surfaces seeded IDs and any seed warnings.
- New `standards_ids` fixture pool — `content_standards` uses
  `standards_id`, not `list_id`, so it gets its own key.

⚠️ Auto-seed mutates agent state. Point at a sandbox tenant — the
fuzzer creates artifacts that the agent owns. There is no teardown.

New public exports: `seedFixtures`, `UPDATE_TIER_TOOLS`,
`DEFAULT_TOOLS_WITH_UPDATES`, and the `SeedOptions` / `SeedResult` /
`SeederName` / `SeedWarning` types.
