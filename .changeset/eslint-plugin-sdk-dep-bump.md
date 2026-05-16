---
'@adcp/sdk': patch
---

chore(eslint-plugin): bump `@adcp/sdk` dep range to `^7.3.0` (#1768)

`packages/eslint-plugin/package.json` declared `"@adcp/sdk": "^7.1.0"` while the CLI workspace already declared `^7.3.0`. The plugin's range now matches so both workspaces resolve against the same minor and lockfile syncs no longer surface an apparent downgrade. No behavior change.
