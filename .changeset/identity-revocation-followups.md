---
'@adcp/sdk': patch
---

Experimental AdCP 3.3 origin revocation fixes (follow-up to #3244): staleness follows the signed `next_update` plus grace, so a list with a longer cadence than the 30-minute polling ceiling is accepted and re-polled instead of rejected; `updated` tolerates 60 seconds of publisher clock skew; a full shared refresh limiter no longer fails an origin still inside its grace; the in-memory store adds a per-operator key budget; and an undated `keyCompromise` detail is never narrowed by a later dated entry.
