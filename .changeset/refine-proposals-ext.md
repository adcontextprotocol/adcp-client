---
'@adcp/sdk': patch
---

Accept the `ext` vendor extension point on `refine_proposals`. `validateRefineProposalsRequest`, which `createAdcpServer` runs before every handler, rejected `ext` on the request and on finalize and revise refinements with `VALIDATION_ERROR`, though the schemas allow it. `ext` is now accepted there when it is an object, and every other unknown key is still rejected. Response verification also accepts `ext` on result items. The request, refinement and result types carry an optional `ext`.
