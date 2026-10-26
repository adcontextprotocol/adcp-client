---
'@adcp/sdk': patch
---

Stop fabricating `media_buy_status` from the task status when a 3.1+ seller omits the optional response `adcp_version` echo (adcp-client#3432). A conformant seller may answer `create_media_buy` or `update_media_buy` with `{ status: 'completed', media_buy_id, ... }`. From AdCP 3.1, that top-level `status` is the task envelope status. The SDK used to treat any un-echoed response as possibly 3.0, so it copied `completed`, `rejected` or `canceled` into `media_buy_status`. Buyers then saw a buy reported as finished, and the storyboard `status.monotonic` invariant rejected a legal create → `active` readback (the symptom from #3395).

The response helpers now use the release the request was sent at (the buyer's `adcpVersion` pin, the release negotiated from it, or the SDK default) when the payload carries no version echo. This applies to the buyer client, `tasks/get` results, the AdCP 3.1 response adapter, response validation and the storyboard runner. `LegacyEnvelopeStatusOptions` and `extractContext` accept an optional `adcpVersion` for this.

Behaviour change for adopters: on a 3.1+ exchange, an un-echoed `status: 'completed' | 'rejected' | 'canceled'` is returned as sent, with no `media_buy_status` added. Read the media-buy lifecycle from `media_buy_status` when the seller sends it.

Unchanged:

- A 3.0 exchange (pinned or negotiated) still moves a lifecycle sent in `status` into `media_buy_status`.
- An explicit `adcp_version` or `adcp_major_version` echo from the seller still takes precedence over the requested release.
- Unambiguous lifecycle values such as `active` keep the existing legacy move.
