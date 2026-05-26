# Migration Guide: v7 → v8

**`@adcp/sdk` v8** tracks **AdCP 3.1.0-beta.3** on the wire. This is a beta line — published to npm under the `beta` dist-tag, not `latest`. `latest` is still `7.11.0` (AdCP 3.0.x).

```bash
npm install @adcp/sdk@beta          # 8.1.0-beta.N
npm install @adcp/sdk                # 7.11.0 (current latest)
```

Upgrade when you're ready to track AdCP 3.1 features. Stay on 7.x if you need GA stability — v8 promotes to `latest` once upstream AdCP 3.1.0 ships.

---

## TL;DR

If you only do these three things, most v7 code keeps working:

1. **On every response your code emits**, set `status` to one of `'completed'` / `'failed'` / `'submitted'` / `'working'`. v8 makes envelope `status` a required field on every wire response.
2. **Run a search-and-replace for the two governance field renames**: `verdict` (was `status`) for `check_governance`, `outcome_state` (was `status`) for `report_plan_outcome`. And `rights_status` (was `status`) for `acquire_rights` / `update_rights`.
3. **If you hit `FATAL: mark-compact: Allocation failed`** during `tsc` against your code: either set `NODE_OPTIONS=--max-old-space-size=8192` _or_ switch to per-tool subpath imports (see "Bundle-split — opt-in adopter affordance" below). The full surface needs 4-6 GB on strict + skipLibCheck:false.

The rest of this guide is the detail for adopters whose code touches the changed surfaces.

---

## Wire-level changes (affect both client and server adopters)

These are AdCP 3.1.0-beta.3 spec changes. They affect the bytes on the wire — any adopter sending or receiving AdCP traffic sees them, regardless of whether they use the SDK's types.

### Envelope `status` is required

Every response body must carry an envelope `status` field. The SDK's `injectEnvelopeStatusIntoResponse` will fill it in on the server side (`'completed'` for success, `'failed'` for error) if your handler doesn't, but if you build response objects by hand or have custom dispatchers, set it explicitly.

```ts
// v7 — accepted
return { products: [...] };

// v8 — wire validator rejects without `status`
return { status: 'completed', products: [...] };
```

Server-side handlers that throw or return error envelopes get `status: 'failed'` automatically.

### `adcp_version` normalized to release-precision on the wire

The wire pattern is `^\d+\.\d+(-[a-zA-Z0-9.-]+)?$` — **no patch digit**. The SDK now normalizes `ADCP_VERSION = '3.1.0-beta.3'` to `'3.1-beta.3'` before emitting. If you embed `adcp_version` in responses by hand, do the same: drop the `.PATCH` segment.

```ts
// v7 emitted
{ adcp_version: '3.0.12', ... }

// v8 must emit
{ adcp_version: '3.0', ... }
// or for beta releases:
{ adcp_version: '3.1-beta.3', ... }
```

### Governance field renames

Two adjacent renames that bit a lot of test fixtures during the v7→v8 sweep:

| Tool                               | v7                                                | v8                                                       | Why                                                                                         |
| ---------------------------------- | ------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `check_governance` response        | `status: 'approved' \| 'denied' \| 'conditions'`  | `verdict: 'approved' \| 'denied' \| 'conditions'`        | Envelope `status` is now task-state (`completed`/`failed`/…); decision needed its own field |
| `report_plan_outcome` response     | `status: 'completed' \| ...`                      | `outcome_state: 'completed' \| ...`                      | Same reason — the outcome lifecycle is distinct from the task envelope                      |
| `acquire_rights` / `update_rights` | `status: 'acquired' \| 'pending_approval' \| ...` | `rights_status: 'acquired' \| 'pending_approval' \| ...` | Same — discriminator collided with envelope `status`                                        |

Adopter code paths that wrote `response.status` to read the governance verdict need updating to `response.verdict` (or `outcome_state` / `rights_status` as appropriate). The SDK's `parseCheckResponse` already reads from `verdict` in v8.

### `governance_agents[]` items lost `categories`

3.1's "single-agent-owns-full-lifecycle" clarification removed the per-agent category-narrowing field. Items now allow only `url` + `authentication`. Adopters emitting `categories: [...]` will be rejected by `additionalProperties: false`.

### Request schemas now `additionalProperties: true`

Mutating request schemas (`create_property_list`, `sync_accounts`, etc.) are now vendor-extension-friendly. Adopters can pass unknown fields on requests without rejection. If you had code depending on strict request validation, that guard is gone — switch to per-request review or move the assertion into your own pre-emit linter.

---

## Type-level changes (affect TypeScript adopters)

### `ProvisioningMode` / `SettingsUpdateMode` got typed

In v7 these were passthrough `Record<string, unknown>`. v8 surfaces the real fields:

```ts
// v7 — passthrough
interface ProvisioningMode {
  [k: string]: unknown;
}

// v8 — typed
interface ProvisioningMode {
  brand: BrandReference;
  operator: string;
  billing: BillingParty;
  billing_entity?: BusinessEntity;
  payment_terms?: PaymentTerms;
  sandbox?: boolean;
  preferred_reporting_protocol?: CloudStorageProtocol;
  notification_configs?: NotificationConfig[];
}
```

Code that was using these as opaque records may now hit type errors on field access. Either embrace the typed shape or cast: `(acct as Record<string, unknown>).foo`.

### `AssetVariant` slot widening

Carousel-style asset slots now accept either a single variant or an array:

```ts
// v7
assets: { [slot: string]: AssetVariant }

// v8
assets: { [slot: string]: AssetVariant | AssetVariant[] }
```

If you read `assets.someSlot.url`, narrow first: `Array.isArray(slot) ? slot[0]?.url : slot.url`. The SDK exports `getAssetSlot(manifest, slotId, assetType)` which returns the array form for any slot.

### `product_card` reshape

`product_card` was `{ format_id, manifest }`; it's now self-rendering:

```ts
// v7
product_card: { format_id: { id: 'product_card_v1', agent_url: '...' }, manifest: { ... } }

// v8
product_card: {
  image: { url: 'https://...', alt: '...' },
  title: 'Acme Widget',
  description: 'A widget.',
  price_label: '$19.99',
  cta_label: 'Buy now',
}
```

### `get_products.products` is now optional

3.1.0-beta.3's `unchanged: true` wholesale-feed branch legitimately omits `products`, but it must still echo `cache_scope`. The Zod schema is `ZodOptional<ZodArray<...>>`. If you had code asserting `products.length`, narrow first.

The SDK's `filterInvalidProducts: true` unwrapper option now correctly handles the optional shape (silent dead-feature regression fixed in 8.1.0-beta.3).

### `cache_scope` is required on product and unchanged `get_products` responses

The populated-products branch and the `unchanged: true` wholesale-feed branch of `get_products` now require `cache_scope: 'public' | 'account'`. Server handlers must set it.

Use `public` for responses with no inline account and no auth-derived/resolved account context, or for account requests that still use the universal rate card. Use `account` when account-specific rate cards or pricing overlays are present. The SDK may infer `public` only when no account context exists; account-scoped product responses must be explicit.

### Union responses are now intersection-wrapped

Several response unions reshaped from bare `z.union([...])` to `z.object({...envelope...}).passthrough().and(z.union([...]))` — the envelope fields became an outer object intersected with the variant union. Affects `create_media_buy`, `activate_signal`, `build_creative`, and a few others.

Adopters narrowing on `'media_buy_id' in response` etc. work unchanged; adopters who reached into Zod internals (`schema._def.options`) need to unwrap one level of intersection first. The SDK's `getBestUnionErrors` does this in v8.

---

## SDK behavior changes (observable side effects)

### Schema-loader strips nested `$id` on bundled responses

v7 had a latent bug: loading any flat-tree tool (e.g. `acquire_rights`) registered `core/*.json` schemas standalone via Ajv's schema registry. Loading any bundled tool (e.g. `activate_signal`) afterwards then tripped Ajv's `checkAmbiguousRef` because the bundled file embeds the same `$id`s inline. **14 tools couldn't validate at all** depending on call order.

v8 strips nested `$id` declarations from bundled response files before passing them to Ajv (`scripts/...schema-loader.ts`). If you have validation tests that exercised the bug (probably as `KNOWN_NONCONFORMING` skips), those tests can be flipped back on.

### `getBestUnionErrors` walks `ZodIntersection`

Tied to the wire reshape above. v7's helper read `schema._def.options` directly. v8 unwraps one level of intersection first (right arm preferred, left as fallback). Adopters using the helper get specific field-level errors again instead of `"Invalid input"` fallthrough.

### `8 GiB heap workaround` on adopter-types check

If you ran `npm run check:adopter-types` against your code and it OOM'd at the default 4 GB Node heap, the SDK now bumps to 8 GB inside the check. That's a workaround, not a fix — see the bundle-split section below for the real answer.

---

## Bundle-split — opt-in adopter affordance

If your tsc OOMs at 4 GB on strict + skipLibCheck:false, or your editor's TS Language Server is slow on `@adcp/sdk` imports, **switch to per-tool subpath imports**:

```ts
// Before — pulls in ~45,000 lines of types, needs 4-6 GB
import type { SyncAccountsRequest } from '@adcp/sdk';

// After — ~900 lines, peaks at ~50 MB tsc memory
import type { SyncAccountsRequest } from '@adcp/sdk/types/sync-accounts';
```

Available for all 50 AdCP tools. Each slice is self-contained — it carries the request/response/success/error types and every type they reference, with no cross-file imports. A machine-readable index ships at `@adcp/sdk/types/per-tool-index.json` mapping spec snake_case names to subpaths.

**Requirements**: `moduleResolution: "node16"` / `"nodenext"` / `"bundler"` on your tsconfig. Older `moduleResolution: "node"` falls back to root imports unchanged.

For agentic adopters (LLM-coded MCP clients reading `.d.ts` as context): per-tool slices are ~12-15k tokens vs ~600k for the full surface. The narrow path is the practical one for context-budget-sensitive agents.

---

## Per-tool checklist

Quick scan for the adopter who knows which tools their code touches:

| Tool                              | Watch for                                                         |
| --------------------------------- | ----------------------------------------------------------------- |
| `check_governance`                | `verdict` field (was `status`)                                    |
| `report_plan_outcome`             | `outcome_state` field (was `status`)                              |
| `acquire_rights`, `update_rights` | `rights_status` field (was `status`)                              |
| `sync_accounts`                   | `ProvisioningMode` / `SettingsUpdateMode` now typed               |
| `sync_governance`                 | `governance_agents[]` items: `categories` removed                 |
| `get_products`                    | `products?:` optional; `cache_scope` required on populated branch |
| `create_media_buy`                | response is `envelope & union` now (not bare union)               |
| `activate_signal`                 | same envelope-intersection reshape                                |
| `build_creative`                  | same; plus `product_card` reshape if you use that template        |
| `preview_creative`                | discriminator on `response_type` ('single' / 'batch')             |
| any tool with manifests           | `AssetVariant` slot widening: `AssetVariant \| AssetVariant[]`    |
| any tool, any response            | envelope `status` is required                                     |

---

## Channel pinning + GA promotion

`@adcp/sdk@beta` will keep getting prerelease bumps until upstream AdCP 3.1.0 ships GA. At that point we'll cut `@adcp/sdk@8.1.0` and move the `latest` dist-tag from 7.11.0 to 8.1.0.

If you want belt-and-braces against accidentally consuming a beta on `latest`, pin exactly:

```bash
npm install @adcp/sdk@8.1.0-beta.11
```

The beta line is API-stable across patch bumps within a single beta (same npm dist-tag); the field renames and reshapes above all landed by 8.1.0-beta.3.

---

## Help

If you hit something not covered here, file an issue at [`adcontextprotocol/adcp-client`](https://github.com/adcontextprotocol/adcp-client/issues) with the AdCP version you're targeting and the surface that broke. The migration sweep cleared the SDK's own test suite (10293 tests passing across all 50 tools); adopter-side surprises are still possible at the seams.
