---
'@adcp/sdk': minor
'@adcp/reporting-storage': patch
---

Address SDK 17 adoption feedback (#3460): preserve the media-buy lifecycle for 3.0 buyers; include collection/proposal account notification types; validate account-change drains at the negotiated release; retain compatible legacy format pairings when a sibling option cannot be mapped; expose shared AssetVariant and targeting key arrays; generate exclusive daypart clock forms and nonempty Zod output types; and shorten unavailable-version diagnostics.

Document all added union/enum members, vendor-metric planning behavior, and pnpm peer convergence in `docs/migration-16-to-17.md`. Release reporting-storage alongside this SDK beta, with `@adcp/reporting-storage@0.3.0-beta.1` requiring SDK `^17.0.0-beta.2`. Install both beta tags together with `--save-exact`; stable storage 0.2.0 continues to require SDK 16. No storage migrations change in this fix.

Zod validation now enforces protocol-authored `minItems` throughout, including render-guidance positions, and preserves nonempty array output types as `[T, ...T[]]`. Empty arrays previously accepted contrary to the schema now fail validation.
