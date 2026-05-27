---
'@adcp/sdk': patch
---

Harden type generation for conditional params by failing on conflicting promoted `params` keys instead of silently keeping the first branch.

Adopters maintaining forked schemas should expect codegen to hard-fail when multiple `allOf[].then.properties.params.properties.*` branches define incompatible shapes for the same promoted key.

Enum order differences are treated as equivalent during this conflict check so schema refactors do not fail only because two branches list the same values in a different order.
