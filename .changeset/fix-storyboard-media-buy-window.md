---
'@adcp/sdk': patch
---

Fix the storyboard `create_media_buy` request builder so stale fixture `start_time` values and same-day fixture `end_time` values cannot resolve to an inverted media-buy window.
