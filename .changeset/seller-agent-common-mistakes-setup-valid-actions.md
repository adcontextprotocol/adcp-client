---
'@adcp/client': patch
---

`build-seller-agent` SKILL.md — document two more Common Mistakes surfaced by real seller-agent builds: (1) placing the IO-signing `setup` URL at the top level of a media buy response instead of nesting it under `account.setup` (response builders now reject this at runtime), and (2) bypassing response builders and forgetting `valid_actions` — `mediaBuyResponse` and `updateMediaBuyResponse` auto-populate it from `status`; `get_media_buys` callers should use `validActionsForStatus()` per buy.
