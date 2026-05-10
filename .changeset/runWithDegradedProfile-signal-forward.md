---
'@adcp/sdk': patch
---

fix(comply): forward AbortSignal into `runWithDegradedProfile` `runOptions`

`complyImpl` already threads its combined timeout/external `AbortSignal` into the `StoryboardRunOptions` it hands to `runStoryboard()` (so `executeStoryboardPass` can bail at the next phase/step boundary). The auth-degraded fallback path (`runWithDegradedProfile`) checked the signal _between_ storyboards but never forwarded it into the runner's options — a single degraded storyboard could still consume the entire timeout budget without firing mid-storyboard. Closes the gap left by #1612 / completes #1615.
