---
"@adcp/sdk": patch
---

Fix adopter `tsc --noEmit` failures caused by transitive dep type errors.

- Raise `@modelcontextprotocol/sdk` peerDep minimum from `^1.17.5` to `^1.29.0` (removes false compatibility claim; older MCP SDK minor versions carried transitive `@types/glob`+`minimatch` incompatibilities)
- Replace `import type { ZodSchema } from 'zod'` in `DecisioningCapabilities` with a local structural interface, eliminating the direct zod import from the emitted `.d.ts` for `@adcp/sdk/server` (zod v4's CTS locale barrel requires `esModuleInterop: true`; this narrows the blast radius)
- Document `esModuleInterop: true` and `skipLibCheck: true` tsconfig requirements in README and BUILD-AN-AGENT guide
- Remove three empty/malformed changeset files that would have silently failed the release pipeline
