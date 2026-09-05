---
'@adcp/sdk': major
---

Push-enabled `TaskHandoff` responses now fail closed with `UNSUPPORTED_FEATURE`
when no terminal task-webhook delivery path is configured. Configure framework
`webhooks` or remove `push_notification_config` for polling-only tasks. The
same rule applies to external settlement, which is polling-only even if a
framework emitter is configured.
