---
'@adcp/sdk': patch
---

Fix four `@internal`-leak bugs that broke adopter `tsc --noEmit` (#1236).

`stripInternal: true` deleted these declarations from the published `.d.ts`
while consumers (the public `AdcpServer` interface, the main `index.d.ts`
re-exports) kept referencing them, producing TS2304/TS2305 errors on every
adopter without `skipLibCheck`:

- `ADCP_SERVER_BRAND` (`server/adcp-server.ts`) — also converted from
  `declare const` to a real `Symbol(...)` const so the binding survives
  emit. Brand is `never`-typed and never set on the runtime object.
- `extractAdcpErrorFromMcp`, `extractAdcpErrorFromTransport`
  (`utils/error-extraction.ts`) — re-exported from `@adcp/sdk`, not
  internal.
- `createSingleAgentClient` (`core/SingleAgentClient.ts`) — re-exported
  from `@adcp/sdk`, not internal.

Adds `npm run check:adopter-types` (wired into CI) which packs the SDK,
scaffolds a minimal adopter, and runs `tsc --noEmit` against the
published types so this class of leak fails CI instead of shipping.
