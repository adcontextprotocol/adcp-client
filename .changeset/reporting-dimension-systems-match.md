---
'@adcp/sdk': patch
---

Reporting subscriptions: offering selection honours `selector.dimension_systems` (adcontextprotocol/adcp#9049). An offering matches only when its `dimension_systems.metro` equals the selector's and its `dimension_systems.postal_area` includes every selector entry. A key the selector omits accepts any system. The canonical vectors are synced to the #9049 merge, adding `match-metro-system-named`, `match-metro-system-omitted` and `match-postal-systems-subset`.
