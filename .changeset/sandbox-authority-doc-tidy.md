---
"@adcp/sdk": patch
---

Doc + deprecation tidy from PR #1453's expert reviews.

Three changes, no behavior change:

- `docs/proposals/lifecycle-state-and-sandbox-authority.md` — adds an explicit "Trust boundary" section at the top of the cross-implementation story. Names what the boundary IS (resolver-stamped `Account.mode`) and what it is NOT (wire `AccountReference.sandbox`, account-id prefix shape, env vars). Calls out the resolver-discipline gotcha: spreading buyer input into the resolved account effectively moves the trust boundary onto the wire, defeating the framework gate.
- `Account.sandbox` (server-side resolved-account interface in `src/lib/server/decisioning/account.ts`) is now `@deprecated` in favor of `Account.mode`. Existing adopters stamping `sandbox: true` continue to work via `getAccountMode`'s legacy fallback. The field will be removed in a future major. Wire-side `AccountReference.sandbox` is unchanged — it's part of AdCP's natural-key disambiguation per the spec's `core/account-ref.json`.
- This changeset itself documents the deprecation queue so the next major bump knows what to drop.

Filed upstream separately: `adcontextprotocol/adcp#4028` (storyboard coverage gap — no scenario exercises comply_test_controller denial against live-mode accounts) and the open question on the protocol-docs `adcp-stack` page about mock-server normative status.
