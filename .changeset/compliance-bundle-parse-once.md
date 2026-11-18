---
'@adcp/sdk': patch
---

Parse each compliance bundle once per compliance scope. The storyboard index (`listAllComplianceStoryboards`) and capability resolution (`resolveStoryboardsForCapabilities`) each loaded every bundle they needed and classified every universal file with a full YAML parse, so a storyboard discovery process parsed the storyboards twice. The index, capability resolution, `resolveBundleOrStoryboard` and `loadSpecialismDetail` now share one parse per bundle and one classification per universal file, keyed like the index cache, and return detached copies. A changed YAML file under a custom compliance root is parsed again. Resolution and the single-bundle paths now report the resolved compliance directory for a relative root, as the index already did.
