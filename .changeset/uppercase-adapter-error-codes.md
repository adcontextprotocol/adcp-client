---
'@adcp/client': minor
---

**Breaking for raw-string callers:** adapter error code string values changed from lowercase-custom (`'list_not_found'`) to uppercase-snake (`'REFERENCE_NOT_FOUND'`, `'UNSUPPORTED_FEATURE'`, etc.) to comply with the AdCP spec's uppercase-snake convention. Closes #700.

**Affected constants** (the KEYS are unchanged, only the emitted string VALUES changed):
- `PropertyListErrorCodes` (`property-list-adapter.ts`)
- `ContentStandardsErrorCodes` (`content-standards-adapter.ts`)
- `SIErrorCodes` (`si-session-manager.ts`)
- `ProposalErrorCodes` (`proposal-manager.ts`)

**Unaffected**: code that uses the exported enum constants. `PropertyListErrorCodes.LIST_NOT_FOUND` still resolves — the key is stable, only the emitted value changed.

**Breaks**: code that pattern-matches raw strings. Multiple `*_NOT_FOUND` keys now collapse to `'REFERENCE_NOT_FOUND'` so string-based switches can no longer distinguish the source domain.

**Migration**: replace raw-string comparisons with the exported helpers + constants.

```ts
// Before — silently stops matching after this change
if (err.code === 'list_not_found') { … }

// After — stable across future value changes
import { isPropertyListError, PropertyListErrorCodes } from '@adcp/client';

if (isPropertyListError(err) && err.code === PropertyListErrorCodes.LIST_NOT_FOUND) { … }
```

**Semver justification**: bumped `minor` rather than `major` because these adapter scaffolds are pre-stable surface intended for implementers extending the stock classes — not yet depended on by downstream shipped products. A repo-wide search found zero raw-string consumers. Value changes in future releases may warrant `major` once implementers are shipping.

Also emitted by this change: `SIErrorCodes.SESSION_TERMINATED` now emits the message `"Session is not active"` (previously `"Session has already been terminated"`) to match the existing `SESSION_EXPIRED` branch — prevents subclass implementers from accidentally leaking terminal-vs-expired state distinction in multi-tenant deployments.
