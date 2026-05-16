---
'@adcp/eslint-plugin': patch
---

chore(eslint-plugin): pin `publishConfig.access` to `public`

Adds `"publishConfig": { "access": "public" }` to `packages/eslint-plugin/package.json`. The 0.1.0 release workflow first-publish failed with `E404` because npm defaults brand-new scoped packages to **restricted** access, which requires either a paid org or an explicit `--access public` flag. With `publishConfig.access` set, future automated `changeset publish` runs publish the package as public without needing the CLI flag — same posture as `@adcp/sdk`, which has been public since first publish.

No runtime change. Rule logic, exports, and dependencies are unchanged.
