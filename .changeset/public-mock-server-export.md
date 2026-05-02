---
"@adcp/sdk": minor
---

Add `@adcp/sdk/mock-server` as a public sub-export.

Adopters can now `import { bootMockServer } from '@adcp/sdk/mock-server'` for in-process integration tests, instead of spawning the published CLI as a child process or reaching into `dist/lib/mock-server/index.js`. Closes #1287.

Same shape as the existing CLI: `bootMockServer({ specialism, port, apiKey? })` returns a `MockServerHandle` with `{ url, auth, close, summary, principalScope, principalMapping }`. Boots in-process so test harnesses can iterate on adapter integration without subprocess overhead.

Examples in `docs/guides/VALIDATE-WITH-MOCK-FIXTURES.md` (when adcp#3826 lands) point at this for the test-side recipe.
