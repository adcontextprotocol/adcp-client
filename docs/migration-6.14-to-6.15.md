# Migrating from `@adcp/sdk` 6.14 to 6.15

> **Status:** Minor release. The single behavior change is on the failure
> path of 18 AdCP tools and is **wire-additive only** — no adopter code
> changes are required, and the new wire shape is what the AdCP response
> schemas have always required. Adopter integration tests that snapshot
> error-response shape may need a one-line update; everything else
> continues to work unchanged.

## Recipe 1: `adcpError()` now emits both wire layers automatically

**TL;DR.** The framework dispatcher auto-wraps the payload-layer
`errors: [{code, message}, ...]` array alongside the existing
envelope-layer `{adcp_error: {code, message, ...}}` block on the failure
path of every tool whose response schema declares a typed Error arm.
Eighteen tools are affected:

| Track             | Tool                            |
| ----------------- | ------------------------------- |
| media-buy         | `create_media_buy`              |
| media-buy         | `update_media_buy`              |
| media-buy         | `provide_performance_feedback`  |
| media-buy         | `build_creative`                |
| event-tracking    | `sync_audiences`                |
| event-tracking    | `sync_catalogs`                 |
| event-tracking    | `sync_event_sources`            |
| event-tracking    | `log_event`                     |
| signals           | `activate_signal`               |
| creative          | `sync_creatives`                |
| creative          | `get_creative_features`         |
| content-standards | `validate_content_delivery`     |
| content-standards | `list_content_standards`        |
| content-standards | `get_media_buy_artifacts`       |
| content-standards | `get_content_standards`         |
| content-standards | `create_content_standards`      |
| content-standards | `update_content_standards`      |
| content-standards | `calibrate_content`             |

The set is derived dynamically from the bundled schema cache at server
build, so future AdCP minors that add Error-arm tools join automatically.

### Why this changes

The AdCP spec (`error-code.json#GOVERNANCE_DENIED`) requires both the
envelope marker and the typed Error arm on tasks whose response defines
an Error arm but no structured rejection arm. `adcpError()` emitted only
the envelope; `wrapErrorArm` emitted only the payload. Both paths now
ship the two-layer wire shape the spec has required since 3.0.6.

### What you don't need to do

- **Don't change call sites of `adcpError()`.** Keep calling it exactly
  as before. The framework synthesises the payload-layer `errors[]` from
  the same `{code, message, field, ...}` data on the way out.
- **Don't change handlers that return `{errors: [...]}` arms directly.**
  The framework synthesises the envelope from the first item.
- **Don't manually emit both layers.** Adopters who already produce a
  fully-formed two-layer response (envelope AND payload) pass through
  unchanged — the dispatcher detects existing layers and does not
  duplicate or overwrite them. This is the documented idempotency
  policy: `adcp_error` and `errors[]` together are the canonical shape;
  the framework only fills in whichever side is missing.

### What might need attention

If your integration tests assert on `structuredContent` shape for one of
the 18 tools above, expect a new top-level `errors[]` field on the
failure path. Update the snapshot or relax the assertion. Tools NOT in
the table (e.g. `get_products`, `get_signals`, `tasks/get`) are
untouched — their response schemas don't declare an Error arm, so the
framework leaves them alone.

### One subtle case: `update_content_standards`

`update_content_standards` is the only Error-arm tool whose response
schema discriminates Success vs Error via a `success: boolean` field
(rather than the presence of `errors[]`). The dispatcher stamps
`success: false` on the synthesised error response so the payload
satisfies the Error arm's `oneOf` discriminator. Adopters who already
emit `success: false` keep that value; adopters who emit `adcpError()`
or a typed Error arm get `success: false` synthesised automatically.

### Where to read more

- Issue: [`adcontextprotocol/adcp-client#1606`](https://github.com/adcontextprotocol/adcp-client/issues/1606)
- RFC: `docs/proposals/adcperror-two-layer-emission.md`
