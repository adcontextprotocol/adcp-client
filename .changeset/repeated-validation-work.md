---
'@adcp/sdk': patch
---

Do schema and compliance work once, or only when it is needed. Results, thrown errors and their messages are unchanged.

- External schema-root checks (`registerExternalSchemaRoot`, `withExternalSchemaRoot`, `withServedReleaseSchemaRoots`) read each document once per call, and reuse what they read from an unchanged on-disk document (same inode, size, mtime and ctime, last changed more than 3 s ago) across calls and across the ESM and CommonJS builds.
- The diagnostic hook that runs on every validator function Ajv generates compares character codes instead of matching regular expressions over the source; it takes about a quarter of the time.
- The AdCP 3.3 draft identity schemas are registered on the first identity validation instead of at import, so importing `@adcp/sdk`, `@adcp/sdk/server` or `@adcp/sdk/testing` no longer builds an Ajv instance for them.
- `createAdcpServer` reads no schema document: it no longer computes an Error-arm inventory it never used. `getErrorArmDescriptor(tool, version)` reads one tool's response schema, once per bundle key, root and generation, and two-layer error emission calls it only when a response carries an error. `getToolsWithErrorArm` stays.
- The storyboard index, capability resolution, `resolveBundleOrStoryboard` and `loadSpecialismDetail` share one parse per compliance bundle and one classification per universal file per compliance scope, and return detached copies. Resolution and the single-bundle paths now report the resolved compliance directory for a relative root, as the index already did.
