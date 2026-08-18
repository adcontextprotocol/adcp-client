# AdCP 3.2 media-buy lifecycle compatibility

SDK 14 separates the tools an MCP seller **advertises** from the compatibility
routes it can still **call**. A 3.2 seller should make the compact lifecycle the
obvious path for new buyers without breaking a 3.0 or 3.1 buyer that already
calls the established names.

## MCP surface comparison

The active 3.2 `media-buy` profile advertises these registered tools:

| Area | AdCP 3.2 active media-buy profile |
|---|---|
| Product and proposal lifecycle | `list_products`, `request_proposals`, `refine_proposals`, `decline_proposals` |
| Purchase and control | `buy_products`, `accept_proposal`, `control_media_buy` |
| Readback | `get_media_buys`, `get_media_buy_delivery` |
| Accounts | `list_accounts`, `sync_accounts`, `get_account_financials`, `report_usage` |
| Creative library | `list_creatives`, `sync_creatives` |
| Media data | `sync_audiences`, `sync_catalogs`, `sync_event_sources`, `log_event`, `provide_performance_feedback` |
| Governance and notifications | `sync_governance`, `sync_agent_notification_configs` |
| Protocol | `get_adcp_capabilities`, `get_task_status`, `list_tasks` |

The deprecated `get_products`, `create_media_buy`, and `update_media_buy` names
are not advertised in that profile. AdCP 3.0/3.1 sellers advertise the legacy
lifecycle instead. `get_media_buys` and `get_media_buy_delivery` remain current
in both generations.

Every framework tool in `tools/list` carries `_meta.adcp_version`. The list
result also carries `_meta.adcp_version` and `_meta.adcp_profile` so a generic
MCP host can display the exact protocol pin and selected role surface without
inferring either from input schemas. Active-profile entries publish the exact,
self-contained draft-2020-12 request projection. Response validation remains
with the framework's AJV validator because current MCP clients apply a declared
success-only `outputSchema` to structured error results too.

## Implement both surfaces from one seller

Use `mediaBuyLifecycle` for the primary 3.2 implementation and keep `sales`
when the endpoint must continue serving older buyers:

```ts
const platform = {
  // accounts, capabilities, statusMappers, ...

  mediaBuyLifecycle: {
    proposalRefinement: {
      supported_dimensions: ['total_budget', 'product_changes'],
    },
    listProducts,
    requestProposals,
    refineProposals,
    declineProposals,
    buyProducts,
    acceptProposal,
    controlMediaBuy,
  },

  // Compatibility facade for AdCP 3.0/3.1 callers.
  sales: {
    getProducts,
    createMediaBuy,
    updateMediaBuy,
    getMediaBuys,
    getMediaBuyDelivery,
  },
};

createAdcpServerFromPlatform(platform, {
  name: 'seller',
  version: '1.0.0',
  adcpVersion: '3.2.0-beta.1',
});
```

With the default `mcpToolProfile: 'auto'`, registering any compact lifecycle
handler on a 3.2 server selects the active media-buy profile. The legacy
handlers stay registered and callable but disappear from `tools/list`.
`mcpToolProfile: 'all'` is available for migration diagnostics; it should not
be the normal production discovery surface.

The compact tools are not mere renames. Proposal digests, immutable terms,
feed and pricing versions, optimistic revisions, and accepted commercial
snapshots make a general field-cast downgrade unsafe. SDK 14 therefore does
not silently translate a compact call into an older tool. A buyer talking to a
3.0/3.1 seller selects the established client methods; a dual-surface seller
implements both facades over the same authorization, storage, idempotency, and
commercial service layer.

A 3.2-only seller may omit `sales` entirely. `getMediaBuys` and
`getMediaBuyDelivery` can live on `mediaBuyLifecycle` alongside the seven
compact lifecycle methods. Authenticated mutations receive an immutable
`ctx.callerMutationScope`; `refineProposals` also receives the framework-owned
`ctx.proposalRefinementScope`. Persist and query proposal state under these
trusted namespaces, never a buyer-supplied proposal ID alone.

## Compatibility matrix to keep in CI

| Buyer | Seller | Expected path |
|---|---|---|
| SDK 14 / AdCP 3.2 | SDK 14 / AdCP 3.2 | Compact lifecycle is advertised and called |
| SDK 14 pinned to AdCP 3.1 | AdCP 3.1 | `get_products` / `create_media_buy` / `update_media_buy` |
| SDK 14 pinned to AdCP 3.0 | AdCP 3.0 | Established tools plus canonical-to-legacy projection |
| Existing AdCP 3.0/3.1 buyer | Dual-surface SDK 14 seller | Known legacy names remain directly callable |

For each lane, assert more than tool presence:

1. `tools/list` exposes the version-appropriate surface and metadata.
2. The request validates against the selected 3.0, 3.1, or 3.2 bundle.
3. Tenant and authenticated-principal scope reaching the business handler is
   identical across both facades.
4. Exact retry keys replay; changed payloads conflict; no cache entry crosses
   a tool, tenant, account, or buyer principal.
5. Product, proposal, media-buy, and delivery reads return the same underlying
   commercial state through the appropriate versioned response projection.
6. Both MCP SDK clients and raw legacy-name calls are covered, so discovery
   filtering cannot accidentally remove compatibility dispatch.

Do not test a compact request by casting it to a legacy request type. Exercise
the actual buyer method and wire schema for each lane.
