---
'@adcp/sdk': major
---

Push-enabled `TaskHandoff` responses now fail closed with `UNSUPPORTED_FEATURE`
when no terminal task-webhook delivery path is configured. Configure framework
`webhooks` or remove `push_notification_config` for polling-only tasks. The
same rule applies to external settlement, which is polling-only even if a
framework emitter is configured.

Supplied malformed `push_notification_config` values now return precise
`INVALID_REQUEST` errors at the configuration, `url`, or `token` field even
when request validation is disabled. Omitted or explicitly `undefined`
configuration remains polling-only. Custom durable task registries used for
external settlement must expose a stable non-empty `registryId` and return
that exact identity from `create()`.
