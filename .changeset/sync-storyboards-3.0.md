---
"@adcp/client": minor
---

Sync storyboards from adcp 3.0: broadcast TV seller, generative updates, governance and status fixes

- Add media_buy_broadcast_seller storyboard (linear TV with Ad-ID, measurement windows, C7 reconciliation)
- Update creative_generative and media_buy_generative_seller storyboards
- Fix governance storyboards: status→decision field, binding structure, domain→.com
- Fix media buy storyboards: status lifecycle (pending_activation→pending_creatives/pending_start)
- Fix path references (media_buys→media_buy_deliveries, field_value additions)
- Fix signal storyboards: validation and path corrections
