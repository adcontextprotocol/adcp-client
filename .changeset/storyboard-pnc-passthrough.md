---
'@adcp/client': patch
---

Storyboard runner now forwards `push_notification_config` from `sample_request` to the outbound request when a programmatic request builder is used (`create_media_buy`, `update_media_buy`, etc.). Previously, only `context`, `ext`, and `idempotency_key` were merged from the hand-authored sample_request on top of the builder output — `push_notification_config` silently fell off the wagon, so every webhook-emission conformance phase (`universal/webhook-emission`, `specialisms/sales-broadcast-tv` window-update webhook, etc.) failed vacuously with the agent under test never receiving the webhook URL. `{{runner.webhook_url:<step_id>}}` substitution is applied to the carried-over config so the runner's ephemeral receiver URL still resolves correctly. Fixes #747.
