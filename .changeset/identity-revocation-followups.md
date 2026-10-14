---
'@adcp/sdk': patch
---

Experimental AdCP 3.3 origin revocation fixes (follow-up to #3244): staleness follows the signed `next_update` plus grace, so a list with a longer cadence than the 30-minute polling ceiling is accepted and re-polled instead of rejected (outage tolerance per successful fetch stays capped at 30 minutes plus grace); `updated` tolerates 60 seconds of publisher clock skew; a full shared refresh limiter no longer fails an origin still inside its grace; the in-memory store adds a per-operator key budget and validates its limits; refresh admission buckets hosts without a registrable domain by hostname instead of throwing; and an undated `keyCompromise` detail is never narrowed by a later dated entry.
