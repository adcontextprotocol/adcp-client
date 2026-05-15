---
'@adcp/sdk': patch
---

fix(ci): run `packages/eslint-plugin/` tests as part of root `npm test` (#1766)

The root `npm test` script now invokes `npm test --workspaces --if-present` after the SDK tests, so CI's `Test & Build` step (which runs `npm test`) exercises the ESLint plugin's rule tests. Plugin tests landed in PR #1762 but weren't running in CI, so plugin regressions could land on main silently.

`--workspaces --if-present` is forward-compatible: any future workspace under `packages/*` that adds a `test` script is automatically picked up. `packages/client-shim` has no `test` script and is skipped (no behavior change there).
