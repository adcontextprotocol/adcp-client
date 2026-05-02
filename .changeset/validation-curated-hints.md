---
"@adcp/sdk": minor
---

`ValidationIssue` now carries a curated `hint` field for known shape gotchas. Closes #1309 (follow-up to #1283).

A small table at `src/lib/validation/hints.ts` maps recognized failure patterns to one-sentence recipes. When a pattern matches, the hint rides on the structured `issues[].hint` and is mirrored into the prose `adcp_error.message` — so adopter LLMs reading the wire envelope alone resolve the gotcha one-shot.

Patterns shipped (all sourced from real adopter pain — matrix-blind-fixtures lineage, `skills/SHAPE-GOTCHAS.md`, and the `skills/call-adcp-agent/SKILL.md` "Gotchas I keep seeing" section):

- `activation_key.type='key_value'` missing `key` or `value` — top-level, not nested under `key_value`
- `activation_key.type='segment_id'` missing `segment_id` — same flatness
- `account` discriminator merging — pick `{account_id}` or `{brand, operator}`, not both
- `budget` as object — it's a number; currency comes from the referenced `pricing_option`
- `brand.brand_id` instead of `brand.domain` — spec uses `domain`
- `format_id` as string — always `{agent_url, id}` (sometimes plus dimensions)
- `signal_ids[]` as bare strings — array of provenance objects
- VAST/DAAST `delivery_type` missing — pair `inline` with `content` or `redirect` with `vast_url`/`daast_url`
- mutating tools missing `idempotency_key` — required UUID, reused on retries

Empirical example post-PR:

```
create_media_buy request failed schema validation at /idempotency_key:
  must have required property 'idempotency_key'
  (hint: Mutating tools require `idempotency_key` (UUID) on every request. Generate fresh per logical operation, reuse the same value on retries.)
```

The rule table is internal — adopters can't currently register custom hints. New patterns get added by PR when at least three adopters or blind-LLM matrix runs hit the same shape and lose ≥1 iteration to "what does this error actually want?". The `hint` field is absent on the long tail; structured `pointer` + `keyword` + `discriminator` + `variants` already cover those cases.

`skills/call-adcp-agent/SKILL.md` updated: recovery order now starts with `hint` when present, then `discriminator`, then `variants`, then leaf fields.
