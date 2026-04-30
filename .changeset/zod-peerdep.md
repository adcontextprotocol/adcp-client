---
'@adcp/sdk': patch
---

Declare `zod` as a required peer dependency (`^4.1.0`).

Adopter-reported issue against the v6.0 RC: `pnpm link` (and `npm link`) against a locally checked-out SDK produced 48 TypeScript errors and a 4 GB tsc OOM, because the linked SDK's nested `node_modules/zod` (4.3.6) competed with the consumer's `zod@4.1.12`. Zod 4's `version.minor` literal type tag made the two copies nominally incompatible — `ZodSchema` from the SDK didn't unify with the consumer's `ZodSchema`.

Without a peer-dep declaration, npm hoisting was the only thing keeping the npm-tarball install path working. The fix:

- Move `zod` to `peerDependencies` with range `^4.1.0` so the consumer's resolution is authoritative.
- Keep `zod` in `devDependencies` for the SDK's own build/test.
- npm 7+ installs peer deps automatically — most consumers see no migration step.
- `npm link` / `pnpm link` users may need `pnpm dedupe` (or removal of the linked SDK's nested `node_modules/zod`) so the consumer's `zod` resolves at the workspace root.

Migration doc updated with the link-mode workaround and a separate note about the zod 4.3.0 `.partial()` regression on `.refine()` schemas (not an SDK bug; SDK builds against 4.1.x to avoid silently bumping consumers into the hazard).
