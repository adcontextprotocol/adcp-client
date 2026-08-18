# Migrating from 13.x to 14 beta

SDK 14 adopts AdCP `3.2.0-beta.0` while preserving the canonical creative boundary introduced in SDK 13. Most SDK 13 applications can install the beta and continue using the established 3.x tools unchanged; adopt the compact 3.2 lifecycle only after the remote agent advertises it.

```bash
npm install @adcp/sdk@beta
```

The untagged npm install remains SDK 13. Keep that line for production AdCP 3.1 deployments until the 3.2 application and its counterparties have completed beta validation.

## Upgrade checklist

1. Pin SDK 14 with the `beta` tag or an exact `14.0.0-beta.*` version. Do not rely on npm `latest` for beta rollout.
2. Preserve capability-gated fallbacks to `get_products`, `create_media_buy`, and `update_media_buy` for AdCP 3.0/3.1 agents.
3. If you use request signing, propagate the negotiated or configured agent version into signing and verification. Expect standard padded Base64 plus mandatory `Content-Digest` only for AdCP 3.2.
4. Return `media_buy_status`, not top-level `status`, from new media-buy server handlers.
5. Add handlers only for the 3.2 tools your server actually implements and advertise the same set in capability discovery.
6. Re-run TypeScript against generated schema imports. Prefer per-tool type slices if the complete schema barrel exhausts the default Node heap.
7. Exercise mixed-version tests before rollout: 14→3.0, 14→3.1, 14→3.2 beta, and older buyer→14 server where applicable.

## Existing 3.x calls remain valid

No mechanical rewrite is required for code that stays on the established lifecycle:

```ts
const products = await agent.getProducts({
  buying_mode: 'brief',
  brief: 'Reach outdoor enthusiasts in Italy',
});

await agent.createMediaBuy(/* canonical SDK 13 request */);
```

SDK 14 retains the canonical/legacy projection layer and the exact compatible-version list for released AdCP 3.0 and 3.1 versions. Keep using the explicit `*Legacy()` methods only for raw wire migration or conformance tooling, just as in SDK 13.

One already state-changing established-tool variant gains optional-key replay
semantics under 3.2:
`get_products({ buying_mode: 'refine', refine: [{ scope: 'proposal', action:
'finalize', ... }] })`. SDK 14 clients attach an `idempotency_key`; preserve it
for an exact retry. SDK 14 servers cache the finalize variant when a valid key
is supplied. The compatibility schema still permits older callers to omit the
key, but those calls cannot receive cache-backed replay protection. Ordinary
discovery and non-finalizing refinement remain read-only. Sellers using the
proposal-manager framework must wire the same durable idempotency store used
by their other commercial mutations.

SDK 14 also hardens replay-cache isolation by including the tool and trusted
resolved session/account identity in canonical replay identity. Existing-tool
cache keys retain their SDK 13 scope so an older durable entry cannot be
missed and executed twice. Because SDK 14's stronger payload identity differs,
a retry against an SDK 13 entry returns `IDEMPOTENCY_CONFLICT` instead of the
old cached body; reconcile by natural key rather than minting a replacement
key until the original replay TTL expires. New entries cannot replay a body
across tenants or tools.

## Adopt the compact lifecycle by capability

The compact flow is not a rename of the established tools. It has different commercial semantics, so branch on the seller's advertised lifecycle tools:

```ts
const capabilities = await agent.getCapabilities();
const tools = new Set(capabilities.mediaBuyLifecycleTools ?? []);

if (tools.has('request_proposals') && tools.has('accept_proposal')) {
  const proposed = await agent.requestProposals({
    // 3.2 request fields from the generated type
  });

  // Select a committed, unexpired proposal from the completed result.
  await agent.acceptProposal({
    account: { account_id: selectedAccountId },
    proposal_id: selectedProposalId,
    proposal_terms_digest: selectedProposalTermsDigest,
  });
} else {
  // Retain the existing get_products/create_media_buy path.
}
```

Use the generated request types or the narrow imports under `@adcp/sdk/types/<tool>` for the exact beta fields. Mutating convenience methods accept SDK-managed idempotency input. Preserve the same request and key for a transport retry; a changed commercial intent needs a new key.

For proposal refinement, validate the advertised limits and supported dimensions, keep hard constraints distinct from legacy discovery filters, and re-check `expires_at` immediately before acceptance. See [AdCP 3.2 proposal negotiation](migration-adcp-3.1-to-3.2-proposals.md).

## Request-signing profiles are versioned

SDK 13 used the legacy AdCP 3.0/3.1 representation. SDK 14 selects between two profiles:

| Agent version | Binary encoding | Signed request `Content-Digest` |
|---|---|---|
| AdCP 3.0 or 3.1 | unpadded Base64URL | governed by the legacy coverage policy |
| AdCP 3.2 | padded standard Base64 | mandatory |

High-level A2A/MCP clients carry the configured agent version automatically. Low-level signing integrations should pass their trusted version context and can inspect the encoding with `requestSigningEncodingForVersion()`.

For a staged server rollout, set the internal verifier option
`signedRequests.covers_content_digest: 'either'` to accept SDK 13 Base64URL
signatures and SDK 14's 3.2 encoding on the same endpoint. Continue advertising
`covers_content_digest: 'required'` in the 3.2 capability document; SDK 14
projects that strict public contract automatically. Move the internal verifier
to `required` after legacy callers are gone.

Do not select a signing profile from a version value inside an unverified request body or header. On the server, bind the version to the endpoint, tenant, or authenticated agent configuration. Webhook signatures do not move to the 3.2 request profile.

## Server handler additions

`createAdcpServerFromPlatform()` routes the new compact lifecycle through
`platform.mediaBuyLifecycle`, including `proposalRefinement` capability
metadata for `refineProposals`. Keep `platform.sales` beside it when the same
seller must accept 3.0/3.1 callers. Both facades should call the same business
services rather than maintaining parallel commercial state.

The generated handler maps cover:

- `list_products`, `request_proposals`, `refine_proposals`, `decline_proposals`
- `buy_products`, `accept_proposal`, `control_media_buy`
- `report_plan_adjustment`
- `sync_agent_notification_configs`

On a 3.2 server, the default `mcpToolProfile: 'auto'` advertises only the
intersection of registered tools and the active spec `media-buy` profile. The
deprecated names remain callable compatibility routes. Use
`mcpToolProfile: 'all'` only for migration diagnostics. MCP `tools/list`
includes `_meta.adcp_version` and `_meta.adcp_profile`, and each framework tool
includes `_meta.adcp_version`.

An SDK 14 server may therefore continue serving 3.0/3.1 clients through the
established tool names without steering new MCP clients toward them. Verify
both facades use the same authorization, tenant isolation, idempotency, and
commercial source of truth. The exact surface comparison and test matrix are
in [AdCP 3.2 media-buy lifecycle compatibility](guides/MEDIA-BUY-3.2-COMPATIBILITY.md).

For create/update media-buy handlers, use `media_buy_status` for the business state:

```ts
return {
  media_buy_id,
  media_buy_status: 'active',
  // ...response fields
};
```

The outer `status` remains the asynchronous task state (`completed`, `working`, `submitted`, `input_required`, or `deferred`).

## Notification and plan-adjustment tools

`syncAgentNotificationConfigs()` replaces the caller's desired agent-level notification configuration declaratively. Treat clear, pause, and replace as authenticated configuration mutations, honor revision fencing, and never merge secrets into logs or `ctx_metadata`.

`reportPlanAdjustment()` is an authenticated, append-only governance record. Replays must be idempotent, but a changed adjustment is a new intent. Scope storage and idempotency to the authenticated tenant/principal rather than a request-supplied account alone.

## Type and schema changes

Regenerated 3.2 types include new tools, error codes, canonical formats, measurement surfaces, and more exact intersections/tuples. If application code imported broad generated types or runtime schemas, expect TypeScript to reveal newly exhaustive unions.

Use focused imports where possible:

```ts
import type { ControlMediaBuyRequest } from '@adcp/sdk/types/control-media-buy';
import { ControlMediaBuyRequestSchema } from '@adcp/sdk/schemas';
```

The repository's own build allocates an 8 GB TypeScript heap for the full surface. Focused application imports avoid paying that cost.

## Rollout and rollback

Keep separate compatibility lanes in CI:

- SDK 14 client → AdCP 3.2 beta reference agent
- SDK 14 client → representative AdCP 3.1 seller
- SDK 14 client → representative AdCP 3.0 seller
- supported 3.0/3.1 client → SDK 14 server

Canary the beta by endpoint or tenant. Rolling back to SDK 13 is safe only while the application continues to preserve the established 3.x tool path and has not made its storage model depend exclusively on a 3.2-only workflow.
