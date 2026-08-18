---
"@adcp/sdk": patch
---

`buildAccount` no longer clobbers an explicit `sandbox: false` from the resolved test kit: `sandbox` now defaults to `true` only when the kit leaves it unset. Fixes the `comply_controller_mode_gate` storyboard, whose live-mode kit (`acme-outdoor-live`, `sandbox: false`) could never reach sellers as a live-mode principal — the storyboard failed every seller regardless of their gate (#2580).
