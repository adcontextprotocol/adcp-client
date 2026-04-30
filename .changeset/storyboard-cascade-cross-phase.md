---
'@adcp/sdk': patch
---

Storyboard runner's stateful-cascade flag now lives at storyboard scope, not phase scope. Cross-phase storyboards (e.g., `signal_marketplace/governance_denied`: governance setup in phase 1, signal-activation assertion in phase 3) reset the cascade at every phase boundary in the previous implementation, so a stateful step that skipped in phase 1 didn't gate stateful consumers in phase 3 — they ran against absent state and surfaced misleading assertion failures. Lifting `statefulFailed` + `statefulSkipTrigger` out of the per-phase loop closes this gap. Adopter-confirmed against the training-agent `/signals` tenant: round-7 was 4/5 storyboards passing for this reason; round-8 should be 5/5.
