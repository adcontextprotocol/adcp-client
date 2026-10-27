---
'@adcp/sdk': patch
---

Cache a bounded storyboard index per resolved compliance/schema authority (#3455). Warm `getComplianceStoryboardById` calls no longer read and parse every YAML in the bundle. List and id lookups return detached storyboards with trusted loader provenance preserved; replacing the bundle index invalidates its cache.
