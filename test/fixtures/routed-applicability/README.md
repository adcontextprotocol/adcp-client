These are unmodified declarations from the exact published protocol bundles:

- `https://adcontextprotocol.org/protocol/3.1.20.tgz`, SHA-256 `ba2041ec6434118464d9f00079578238dabc1bb3d2d6f7511ddb2cc9772fae28`
- `https://adcontextprotocol.org/protocol/3.1.23.tgz`, SHA-256 `1b6ea825851dc052aeecd055c09633555335ab19d425c106d67060ed01ae6b9e`

Downloaded and verified against their published `.sha256` sidecars on 2026-09-14. `manifest.json` maps each original compliance-relative path to its SHA-256 and local file. Identical files are stored once. The corpus contains both original #7404 declarations and all five governance/provenance declarations identified in the follow-up to SDK #2882. No steps or fixtures have been removed or rewritten.

The tests distinguish any-of storyboard applicability from per-agent executable steps. These declarations do not supply a generic same-agent execution contract through `required_tools`. The governance scenarios omit a machine-readable governance-aware capability predicate, while the three provenance fixtures contain products without `format_ids`. Two provenance scenarios satisfy even an all-of selector on the reporter's seller. They require protocol/fixture work, not a global all-of gate or a grading exemption.

Routed controller seeding remains an explicit runner refusal: these full storyboards require externally provisioned fixtures and `skip_controller_seeding: true` before a routed run. Tests preserve that refusal and also run every phase with the explicit external-seeding option. `routed-rejections.json` records exact outcomes for split and complete toolsets with deterministic rejecting endpoints: selected steps fail, supported dependents retain failed prerequisite skips, and tools missing on the selected route remain missing-tool skips even when another agent advertises them. This expected-results file is test evidence, not an upstream artifact. The independent positive step matrix uses actual routed discovery and dispatch.
