---
'@adcp/sdk': patch
---

Harden type generation for conditional params by failing on conflicting promoted `params` keys instead of silently keeping the first branch.
