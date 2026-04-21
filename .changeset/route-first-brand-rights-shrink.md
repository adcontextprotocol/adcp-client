---
'@adcp/client': patch
---

Skill docs follow-ups from the agent-skill-storyboard harness runs:

- `build-seller-agent/SKILL.md` § sales-guaranteed restructured to lead with a 3-row routing table (IO signing → `submitted` task envelope / `creative_assignments` empty → synchronous `pending_creatives` / otherwise → `active` with `confirmed_at`). The old section led with "IO approval = task envelope" and fresh Claude defaulted to `submitted` for every scenario, missing the `pending_creatives` path. The routing logic is now the first code block in the section.
- `build-brand-rights-agent/SKILL.md` shrunk from 472 → 415 lines (~12%) by collapsing the duplicated idempotency and `Protecting your agent` content into pointers at the seller skill. The long skill was causing the `agent-skill-storyboard.ts` harness to time out before Claude wrote `server.ts`.
- Dropped the stale "ai_generated_image not in enum" warning — upstream adcontextprotocol/adcp#2418 merged, enum now lists `ai_generated_image` + `image_generation`.

No public-surface changes; docs-only patch.
