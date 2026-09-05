---
'@adcp/sdk': major
---

Push-enabled `TaskHandoff` responses now fail closed with `UNSUPPORTED_FEATURE`
when no terminal task-webhook delivery path is configured. Configure framework
`webhooks` or remove `push_notification_config` for polling-only tasks. The
`externallyManagedTaskWebhooks` escape hatch is only for durable
`settlement: 'external'` handoffs: producers must atomically persist
`taskCtx.terminalWebhook` with the scoped task reference, while their workers
own signed, at-least-once terminal delivery, retries, durability, and
`operation_id` correlation.
