---
'@adcp/sdk': patch
---

The storyboard runner no longer records `context.media_buy_id` or `context.media_buy_status` from an interim `create_media_buy` or `update_media_buy` task envelope (`submitted`, `working` or `input-required`). Before, a `working` envelope that carried a `media_buy_id` populated the context as if the buy had completed synchronously (or the update had applied), so storyboards that gate on `context.media_buy_id` (such as `webhook_emission`'s synchronous-completion check) misclassified an asynchronous seller. Any other response extracts as before. A storyboard that needs the identifier from an asynchronous create can capture it with a `task_completion.media_buy_id` context output (adcp-client#3682).
