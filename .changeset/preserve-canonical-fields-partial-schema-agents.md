---
'@adcp/sdk': patch
---

Never strip canonical AdCP request fields when a sales agent advertises a partial tool inputSchema. The client previously intersected outgoing top-level fields with only the agent's self-declared `tools/list` schema, so agents that under-declare their schema caused canonical — sometimes required — fields (e.g. `media_buy_id` on `update_media_buy`, `media_buy_ids` on `get_media_buy_delivery`, `creative_ids` on `sync_creatives`) to be dropped before the request left the client, breaking media-buy updates and delivery polling. Fields are now preserved when declared by the agent schema, present in the protocol envelope, OR canonical for the task in the resolved AdCP version; only fields unknown to both the agent schema and the canonical request schema are stripped.
