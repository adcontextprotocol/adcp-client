---
'@adcp/sdk': minor
---

Add request-only Targeting Input helpers for the AdCP 3.2 null-clear semantics (DR-0020) and stop
`createMediaBuyStore` from persisting a clear command.

`resolveTargetingInput`, `applyTargetingInput`, and `hasTargetingClears` are exported from the root
and `@adcp/sdk/server`. They project between the request-only Targeting Input — where a dimension may
be `null` to suppress a product default on create or clear stored state on update — and the strict
Targeting Overlay used by discovery criteria, accepted commercial snapshots, mutation responses, and
package readback, which must not contain `null`.

Two fixes in `createMediaBuyStore`, both reachable only once rc.3 makes the nullable input types
real: `persistFromCreate` fell back to the request overlay verbatim when the seller's response did
not echo one, and the `new_packages` arm of `mergeFromUpdate` assigned the incoming overlay directly.
Either path could write a `null` clear command into durable state, which `backfill` would then echo
into a `get_media_buys` response whose schema forbids null. Both now resolve clears away, and a patch
that clears the last surviving dimension drops the tracked overlay instead of persisting `{}`.

The store's `CreateMediaBuyInputForStore` / `UpdateMediaBuyInputForStore` input types widen from the
strict overlay to the request shape, so passing a real `create_media_buy` / `update_media_buy`
payload typechecks. Persisted and echoed values remain strict.

Codegen fix: `TargetingOverlayInput.device_platform` and `.device_type` were emitted as the scalar
`DevicePlatform` / `DeviceType` enums instead of arrays. `core/targeting-input.json` reaches those
dimensions through a JSON-pointer `$ref` into `core/targeting.json#/properties/<dimension>`, and for
an array with no `title` of its own json-schema-to-typescript names the result after the items'
canonical `$ref`. Both types now match the wire.
