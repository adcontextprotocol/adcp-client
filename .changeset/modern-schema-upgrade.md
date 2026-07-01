---
'@adcp/sdk': patch
---

Upgrade the bundled AdCP protocol schemas to 3.1.1.

The hosted property registry write path now treats `authorized_agents` as optional and defaults omitted values to `[]` for older registry compatibility. Sales authorization remains origin-based; callers should use hosted-property claim and verify-origin helpers for ownership binding.
