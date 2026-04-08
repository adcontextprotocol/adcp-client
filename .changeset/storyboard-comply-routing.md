---
"@adcp/client": minor
---

Storyboard-driven compliance routing: comply() now resolves storyboards directly instead of routing through tracks. Added `storyboards` option, `PLATFORM_STORYBOARDS` mapping, `extractScenariosFromStoryboard()`, and `filterToKnownScenarios()`. Tracks are now a reporting layer derived from storyboard results.
