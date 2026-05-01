---
'@adcp/sdk': patch
---

fix(skill): build-creative-agent SKILL.md surfaces strict-mode `Format.renders[]` + `Format.assets[]` shapes prominently

Closes adcontextprotocol/adcp-client#1210.

Pre-fix, the skill mentioned the strict-shape requirement only in a table-cell gotcha (`renders[]` MUST have `role` + `dimensions`) and showed a worked example deep in the implementation section. The matrix v2 run on PR #1207 confirmed this isn't enough — Claude built creative-template agents that emitted `renders: [{ width, height }]` (the exact shorthand the gotcha warns against) and `assets: [{ asset_id, asset_role, required }]` missing the `asset_type` discriminator. Lenient validation passed; strict validation flagged both.

Empirical evidence (from `.context/matrix-mock-run-3.log`, the ✗ run):

```
strict JSON-schema missing required at /formats/0/renders/0/dimensions: dimensions
strict JSON-schema missing required at /formats/0/renders/0/role: role
strict JSON-schema missing required at /formats/0/assets/0/asset_type: asset_type
strict JSON-schema rejected /formats/0/renders/0: must match exactly one schema in oneOf
```

Fix: promote the strict-shape requirement into the **cross-cutting pitfalls callout** at the top of the "Tools and Required Response Shapes" section, with explicit ✗-WRONG / ✓-RIGHT side-by-side. Also tightens the table-cell gotcha to mention the asset discriminator quartet (`item_type` + `asset_id` + `asset_type` + `required`).

Skills are bundled with the npm package (`files: ["skills/**/*"]`), so this is a publishable change.

Verification path: re-run `npm run compliance:skill-matrix -- --filter creative_template` against the new skill; strict-mode warnings should disappear.
