---
"@adcp/client": patch
---

Fix docs/guides/BUILD-AN-AGENT.md create_media_buy CLI example to match current schema: PackageRequest uses `product_id` + `budget` (plain number) + `pricing_option_id`; `brand` uses `{domain}` discriminator; `idempotency_key` is required. Adds `--protocol a2a` usage examples to VALIDATE-YOUR-AGENT.md.
