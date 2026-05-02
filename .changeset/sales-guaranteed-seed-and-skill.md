---
"@adcp/sdk": patch
---

fix(seller skill + sales-guaranteed mock seed): align with `sales_guaranteed` storyboard fixtures.

**Mock seed** (`src/lib/mock-server/sales-guaranteed/seed-data.ts`) — adds `acmeoutdoor.example` and `pinnacle-agency.example` networks (with ad units + products). The `sales_guaranteed` storyboard sends fixtures with these publisher domains; the prior seed only had `premium-sports.example`, so blind agents saw 404 on every `_lookup/network` and were forced into a fallback that contradicted the skill's "fail closed on 404" advice. Adapter authors who fork the published mock now resolve cleanly.

**Seller skill row** (`skills/build-seller-agent/SKILL.md`) — collapses the `sales-guaranteed` specialism row to a one-sentence summary that points at the companion file. The prior wording said "Do NOT return media_buy_id or packages yet" without the qualifier "for the IO-approval path"; blind agents read this as universal advice and returned task envelopes for every `create_media_buy`, failing 5 storyboard steps on the synchronous branches. The companion file (`specialisms/sales-guaranteed.md`) already had the correct three-path table; this just stops the SKILL.md row from contradicting it.

Tracked at adcontextprotocol/adcp#3821 (skill ↔ storyboard contradiction) and adcontextprotocol/adcp#3822 (fixture seed misalignment).
