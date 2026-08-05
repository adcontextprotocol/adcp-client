---
'@adcp/sdk': patch
---

Project `sync_creatives.assignments` from the AdCP 3 edge-list shape into the creative-keyed object required by AdCP 2.5 sellers. Assignment weights and placement restrictions now fail closed when targeting a 2.5 seller because that wire version cannot represent them. Callers that manually supplied the v2.5 object as a workaround should return to the public AdCP 3 array shape.

Refresh generated registry types for the latest canonical creative-capability, placement-summary, and registry-feed fields.
