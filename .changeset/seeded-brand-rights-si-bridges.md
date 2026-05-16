---
'@adcp/sdk': minor
---

feat(testing): brand-rights + SI seeded bridges (#1755 phase 4)

Extends `TestControllerBridge<TAccount>` with three opt-in callbacks so platform-proxy sellers can seed brand-rights and sponsored-intelligence fixtures into conformance storyboards without driving real upstream calls:

- `getSeededBrandIdentity(ctx) → GetBrandIdentitySuccess[]` — feeds `get_brand_identity` via singleton replace: pick by `request.brand_id` matching entry `brand_id`, replace the success body and preserve handler `context` / `ext` (framework-managed envelope fields, mirrors `replaceContentStandardsIfSeeded`). Unblocks the `brand-rights` storyboard identity-discovery phase.

- `getSeededRights(ctx) → GetRightsSuccess['rights'][number][]` — feeds `get_rights` via append-merge by `rights_id`, seeded wins on collision (mirrors `getSeededProducts` — `get_rights` is a discovery / search tool with an NL `query`, so the response carries an array; no `pagination` / `query_summary` blocks per AdCP 3.0.11). Unblocks the `brand-rights` storyboard rights-discovery phase.

- `getSeededSiOffering(ctx) → SIGetOfferingResponse[]` — feeds `si_get_offering` via singleton replace: pick by `request.offering_id` matching entry's nested `offering.offering_id`, replace the response body and preserve handler `context` / `ext`. Stateless lookup despite the broader SI flow being session-keyed: `si_get_offering` PRODUCES an `offering_token` for a future session but does not CONSUME one, so the singleton-replace pattern fits cleanly. Unblocks the `sponsored-intelligence` storyboard offering-lookup phase.

All three bridges follow the established triply-gated sandbox check (controller present + sandbox marker on request + resolved account is `sandbox: true` when `resolveAccount` produced one), seeded-wins collision precedent, warn-and-drop validation contract (never throws), and `context` / `ext` preservation policy on singleton replace. `BridgeFromSessionStoreOptions` gains matching `selectSeededBrandIdentity` / `selectSeededRights` / `selectSeededSiOffering` selectors.

The session-stateful SI tools (`si_initiate_session`, `si_send_message`, `si_terminate_session`) are intentionally NOT bridged — they consume session state that a static fixture can't honestly serve. The mutating brand-rights tools (`acquire_rights`, `update_rights`) are NOT bridged either — seeded read paths only, per phase 4 scope.
