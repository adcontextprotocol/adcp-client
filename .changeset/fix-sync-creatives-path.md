---
"@adcp/client": patch
---

Fix storyboard field name drift: governance `decision`→`status`, creative `results`→`creatives`, audit log `entries`→`plans[0].entries`, setup path nesting. Fix context extractors for build_creative, sync_creatives, activate_signal, create_property_list. Deprecate `CommittedCheckRequest.mediaBuyId` (removed from protocol). Add schema drift detection test.
