---
"@adcp/sdk": minor
---

Export canonical `MediaBuy` / `Creative` lifecycle graphs from `@adcp/sdk/server`.

New surface:

- `MEDIA_BUY_TRANSITIONS: ReadonlyMap<MediaBuyStatus, ReadonlySet<MediaBuyStatus>>`
- `CREATIVE_ASSET_TRANSITIONS: ReadonlyMap<CreativeStatus, ReadonlySet<CreativeStatus>>`
- `isLegalMediaBuyTransition(from, to)` / `isLegalCreativeTransition(from, to)` — boolean predicates
- `assertMediaBuyTransition(from, to)` / `assertCreativeTransition(from, to)` — throw `AdcpError` with the spec-correct code (`NOT_CANCELLABLE` for the cancel-idempotency path, `INVALID_STATE` everywhere else)

These maps are the same source the storyboard runner's `status.monotonic` invariant uses — production sellers that enforce transitions with these helpers cannot drift from conformance enforcement. Previously sellers had to copy the graph into their own code (three example files were doing this); spec-version bumps to the lifecycle would silently desync them. Closes #1416.

The two test-controller examples (`examples/seller-test-controller.ts`, `examples/comply-controller-seller.ts`) now consume the SDK predicates instead of redefining the table.
