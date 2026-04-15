---
"@adcp/client": minor
---

Add media buy response builders that eliminate common implementation traps: validActionsForStatus() maps status to valid actions, mediaBuyResponse() auto-defaults revision/confirmed_at/valid_actions, cancelMediaBuyResponse() requires cancellation metadata. Sync schemas from latest AdCP.
