---
'@adcp/sdk': minor
---

Adopt the canonical universal-macro translation fixture. `translateUniversalMacros` now reports literal consent mappings in `frozen_consent_macros` and throws the exported `UnsafeNativeMappingError` when any native mapping contains an ASCII C0 control character or DEL, including unused mapping entries.
