---
"@adcp/client": minor
---

Brand `AdcpServer` as nominal + lint `as any` in skill examples.

Two complementary defenses against the API-drift class that landed PR #945 (the creative skill teaching `server.registerTool`):

- **`AdcpServer` is now a branded (nominal) type.** A phantom symbol-keyed property (`[ADCP_SERVER_BRAND]?: never`) makes `(plainObject as AdcpServer)` casts from structurally-similar objects fail at compile time. A real `AdcpServer` is only obtainable by calling `createAdcpServer()`. Closes the door on `(somePlainObject as AdcpServer).registerTool(...)` patterns that tried to reach for an MCP-SDK method the framework intentionally doesn't expose. Type-only change — no runtime behavior, no breaking change for any caller passing a value produced by `createAdcpServer()`.

- **`scripts/typecheck-skill-examples.ts` now flags `as any` in extracted skill blocks.** The pattern hides the API drift that strict types would otherwise catch — every legitimate cast has a typed alternative (typed factories like `htmlAsset()`, named discriminated unions like `AssetInstance`, response builders like `buildCreativeResponse()`). New `as any` in a skill block fails the harness; existing uses in `skills/build-seller-agent/deployment.md` (Express middleware boundary code, 2 occurrences) are baselined as known. Authors who genuinely need the escape hatch can use `// @ts-expect-error` against a specific known issue instead — greppable and self-documenting.

Type-level test in `src/lib/server/adcp-server.type-checks.ts` locks the brand against regression — if a future change accidentally removes the brand, `tsc --noEmit` fails because the negative assertions stop firing.

This is dx-expert priority #4 from the matrix-v18 review (CI defenses #1–#3 shipped in #945, #957, #961).
