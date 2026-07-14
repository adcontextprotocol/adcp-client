---
'@adcp/sdk': patch
---

Harden the publish artifact and correct a peer-dependency floor.

- Raise the `@modelcontextprotocol/sdk` peer floor from `^1.17.5` to `^1.24.0`.
  The main entry eagerly loads `server/tasks`, which imports
  `@modelcontextprotocol/sdk/experimental/tasks/*`; those subpaths first ship in
  1.24.0, so any consumer importing `@adcp/sdk` on an older MCP SDK hit
  `ERR_MODULE_NOT_FOUND`. Same class of too-low pin as the `@a2a-js/sdk` fix.
- Emit ESM-format type declarations (`.d.mts`) alongside `.d.ts` and give every
  subpath export per-condition types, so the ESM `import` condition no longer
  resolves to a CJS declaration ("masquerading as CJS"). `@adcp/sdk/enums`'s
  `import` condition now points at `enums.mjs`, and `enums`, `testing/personas`,
  and `server/legacy/v5` gained the `typesVersions` entries they were missing.

The `@modelcontextprotocol/sdk` peer floor is raised `^1.17.5` → `^1.24.0`:
consumers must be on `@modelcontextprotocol/sdk` ≥ 1.24 (the main entry eagerly
loads `server/tasks`, which imports `experimental/tasks/*`, absent before 1.24.0).

Verification tooling only (devDependencies, no new runtime deps): `npm run
check:package` (publint + attw) and `npm run verify:package` (clean-room
dual-format smoke against the packed tarball with peers at their range floors),
both wired into CI. See `docs/development/PACKAGE-VERIFICATION.md`.
