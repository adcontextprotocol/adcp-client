---
'@adcp/sdk': patch
---

Route `update_media_buy` task handoffs through the framework task registry so
background updates receive the same caller scope, polling support, and webhook
lifecycle as `create_media_buy`.

**Upgrade warning:** adopters that worked around this bug by calling
`taskRegistry.create(...)` manually must remove that workaround before
upgrading. Leaving both paths active can register the update twice and emit
duplicate async completion webhooks; the framework does not deduplicate a
manually registered task against `ctx.handoffToTask(...)`.
