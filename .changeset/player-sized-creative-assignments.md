---
'@adcp/sdk': minor
---

Resolve creative assignments per package and include package refs in projection errors. Add an opt-in playerSizedRefs policy that omits unstated player dimensions for shared VAST creatives when every package agrees on one legacy format identity and duration.

Every assigned package for a canonical creative now needs its own selector evidence or resolver answer; missing packages cannot borrow another package's ref. Creative resolver calls for multi-package assignments receive each package's container (including package_id), instead of the pooled selector wrapper.

Already-legacy creatives with a stated size also refuse incompatible package evidence instead of ignoring conflicting assignments. Supply selectors for every assigned package, and update resolvers that previously read the pooled selector_containers wrapper to read the package container directly.
