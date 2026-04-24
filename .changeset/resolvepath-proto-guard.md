---
"@adcp/client": patch
---

Hardened `resolvePath` in the storyboard runner to apply the same `FORBIDDEN_KEYS` + `hasOwnProperty` guard that `resolvePathAll` and `setPath` already use. A storyboard path like `__proto__.polluted`, `constructor`, or `hasOwnProperty` now resolves to `undefined` (not-found) instead of projecting `Object.prototype` state into validation results. No call site relied on the permissive behavior. Surfaced by the security review on #876.
