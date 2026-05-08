---
'@adcp/sdk': patch
---

test(storyboard): refactor `test/lib/storyboard-cascade-skip-on-skip.test.js` from prose-driven scenarios to a `(skip_reason × peer_shape × phase_topology)` fixture-table matrix (#1548)

Test-only change. Preserves all 35 historical assertions but reorganizes them as named matrix rows with a coverage-holes assertion at the bottom that fails CI when a new dimension value is introduced and left uncovered. Empty cells in the cube are now structurally visible to reviewers rather than discovered as production bugs (the asymmetric blind spot pattern that PR #1545 fixed). Net line shrink ~41% (2143 → 1256). No runner behavior change.
