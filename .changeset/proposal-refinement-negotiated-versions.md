---
"@adcp/sdk": patch
---

Support proposal refinement on negotiated AdCP 3.3 and later minor releases within major 3, while retaining the 3.2 minimum and release-precision wire validation. Bind response verification and nested proposal/change-term schemas to the negotiated version; reject mismatched echoes and unavailable selected schemas without changing digest, lineage, hold or atomic-finalize checks.
