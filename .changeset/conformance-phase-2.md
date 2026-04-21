---
'@adcp/client': minor
---

Conformance fuzzer Phase 2 (#698) — referential tools, fixture injection,
and `adcp fuzz` CLI.

- **Referential stateless tools**: 6 new tools in the default run —
  `get_media_buy_delivery`, `get_property_list`, `get_content_standards`,
  `get_creative_delivery`, `tasks_get`, `preview_creative`. Random IDs
  exercise the rejection surface (agents must return
  `REFERENCE_NOT_FOUND`, not 500).
- **Fixtures**: new `RunConformanceOptions.fixtures` option. When a
  request property name matches a pool (`creative_id`/`creative_ids`,
  `media_buy_id`/`media_buy_ids`, `list_id`, `task_id`, `plan_id`,
  `account_id`, `package_id`/`package_ids`), the arbitrary draws from
  `fc.constantFrom(pool)` instead of random strings — testing the
  accepted path on referential tools.
- **`adcp fuzz <url>` CLI**: new subcommand with `--seed`, `--tools`,
  `--turn-budget`, `--protocol`, `--auth-token`, `--fixture name=a,b`,
  `--format human|json`, `--max-failures`, `--max-payload-bytes`, and
  `--list-tools`. Exits non-zero on failure. Reproduction hint on every
  failure: `--seed <seed> --tools <tool>`.

```bash
adcp fuzz https://agent.example.com/mcp --seed 42
adcp fuzz https://agent.example.com/mcp --fixture creative_ids=cre_a,cre_b --format json | jq
```

New public exports: `REFERENTIAL_STATELESS_TOOLS`, `DEFAULT_TOOLS`,
`ConformanceFixtures`, `SkipReason`.
