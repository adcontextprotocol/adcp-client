---
'@adcp/sdk': patch
---

Fix mixed-size creative library syncs by excluding known non-fitting packages from an unassigned creative's shared wire decision. Apply the same fit checks and option selection to library uploads when assignments name other creatives; these uploads now refuse when no supplied package can accept them. Preserve strict assignment checks for both assignments and assignment_operations (assign, replace, and merge), refuse conflicting compatible wire references, and retain all public per-package fit verdicts.
