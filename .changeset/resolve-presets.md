---
'@adcp/sdk': minor
---

feat(server): `accounts.resolve` security presets — `requireAccountMatch`, `requireAdvertiserMatch`, `requireOrgScope`. Standardize the post-resolve authorization pattern multi-tenant adopters reach for ("the inner resolver found the account, but is the calling principal authorized for it?") so each adopter doesn't roll their own. Compose with `composeMethod` over `accounts.resolve`; default deny is `null` (avoids principal enumeration) with opt-in `onDeny: 'throw'` for `PermissionDeniedError`. Closes #1339.
