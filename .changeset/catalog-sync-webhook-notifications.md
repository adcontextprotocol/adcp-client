---
'@adcp/sdk': patch
---

Pick up AdCP 3.1.0-beta.3 wholesale feed schemas, including account-level `sync_accounts` notification configs for product/signal feed webhooks. The wholesale feed mirror now uses `if_wholesale_feed_version` conditional reads and applies inbound `WholesaleFeedWebhook` payloads directly; the removed `/catalog/events` polling path is no longer used.
