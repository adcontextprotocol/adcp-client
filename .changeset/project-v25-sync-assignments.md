---
'@adcp/sdk': patch
---

Project `sync_creatives.assignments` from the AdCP 3 edge-list shape into the creative-keyed object required by AdCP 2.5 sellers. Assignment weights and placement restrictions now fail closed when targeting a 2.5 seller because that wire version cannot represent them.
