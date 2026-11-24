---
'@adcp/sdk': minor
---

Testing: add `test_kit_auth`, a credential laid over each storyboard's declared test kit (adcontextprotocol/adcp#8929).

A grader that presents its own credential through a run-level `test_kit` replaces every storyboard's declared kit (`prerequisites.test_kit`), so no storyboard gets its own fixtures: asset files for `$build_assets_from_format`, `commercial_relationship` for phase gates, creative build recipes, and so on. `test_kit_auth` keeps each declared kit and changes only its credential.

- `comply()`, `runStoryboard()`, `runStoryboardStep()` and `prepareStoryboardFixtures()` accept `test_kit_auth`, with the same shape as `test_kit.auth`. Each storyboard loads its declared kit. A kit that declares `sandbox: true`, or carries no credential of its own (runner-contract kits), gets `test_kit_auth` as its whole `auth` block, so none of the kit's own `api_key`, `basic` or `probe_task` sits next to your credential. The kit is validated after the overlay.
- A kit that declares `sandbox: false`, or carries a credential without declaring `sandbox: true`, keeps its own `auth`: it may be the live-mode principal the storyboard tests (adcontextprotocol/adcp#6735). An absent `sandbox` is never read as sandbox, as in `getSandboxEntities()`.
- A storyboard that declares no kit gets `{ auth: test_kit_auth }`, as it would from a run-level kit. A declared kit that cannot be loaded (no compliance root, or no such file) gets no overlay, so its `from_test_kit` steps fail as a configuration error, as they would without `test_kit_auth`.
- Without run-level `auth`, `comply()`'s own discovery authenticates with `test_kit_auth`, as it does with `test_kit.auth`.
- `probe_task` is required and must be allowlisted. `test_kit` and `test_kit_auth` together throw `TestKitValidationError` before the agent is contacted. `@adcp/sdk/testing` exports the `TestKitAuth` type, the shape of both `test_kit.auth` and `test_kit_auth`.
