---
"@adcp/client": patch
---

Fix webhook HMAC verification by propagating X-ADCP-Timestamp header through AgentClient.handleWebhook() and server route. Update update_media_buy tool signature to remove push_notification_config (matches create_media_buy). Add auto-injection of reporting_webhook in createMediaBuy when webhookUrlTemplate is configured.
