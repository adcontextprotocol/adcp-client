---
'@adcp/client': patch
---

`skills/call-adcp-agent/SKILL.md`: two dx-driven additions for naive LLM callers.

1. **Replay semantics on `idempotency_key`.** The skill now spells out what "same key → cached response" actually means in practice — same `task_id`, same `media_buy_id`, byte-for-byte identical — and warns against the most common doubling pattern (generating a fresh UUID on retry). Async flows replay against the same `task_id`, so polling continues against the same task instead of forking.

2. **Symptom → fix table.** A quick lookup of the most common `adcp_error.issues[*]` shapes mapped to their one-line fix: merged `oneOf` variants, missing `idempotency_key`, `budget` as object, `format_id` as string, made-up `destinations[*].type`, async `status: 'submitted'`, the three `recovery` modes (`retryable` / `correctable` / `unsupported`), and HTTP 401. Designed to short-circuit the recovery loop before the caller has to read the whole envelope schema.

Docs-only — no library/CLI behavior change. Pairs with the `variants[]` enrichment shipped in [#919](https://github.com/adcontextprotocol/adcp-client/pull/919).
