---
'@adcp/sdk': minor
---

`createAdcpServer` (and `createAdcpServerFromPlatform`) now converts between the server's AdCP release and an older buyer's, so handlers are written against one release (adcp-client#3370, adcontextprotocol/adcp#8373).

- **Responses convert down.** When the served release is older than the server's `adcpVersion`, the handler's response is converted down one minor at a time before response validation. Each step runs hand-written adapters (for 3.1, the root `currency` on `get_media_buy_delivery` is filled from a shared per-buy currency), then removes what the older release's response schema cannot express. Removed and moved fields are logged at `info` with their JSON paths. Responses that already have the older shape, such as those from handlers that branch on `ctx.servedAdcpVersion` today, pass through unchanged.
- **Requests convert up** through each step's `upgradeRequest` adapters before the handler runs. No 3.0 → 3.1 or 3.1 → 3.2 request rule is needed yet: older requests remain valid in the newer shape. `ctx.servedAdcpVersion` still reports the served release.
- **What stays the same.** `get_adcp_capabilities` keeps its own per-release projection. Error envelopes, custom tools, task tools and the identity 3.3 experiment are not converted.
- **Behavior change.** A buyer that sends only `adcp_major_version` is served the oldest advertised release, so with default settings it now receives 3.0-shaped responses, where the handler's output used to go out unchanged.
