---
'@adcp/sdk': patch
---

Experimental AdCP 3.3 trust, grant and authorization fixes (follow-up to #3244): per-host trust fetch rates are keyed by (operator, host) so another operator's `authoritative_location` cannot exhaust a victim's budget, and a host-rate refusal is not cached as a 60-second failure; unreadable trust records raise `TrustRecordUnavailableError` and definitive delisting raises `TrustMembershipError`; a delisted bound origin falls back to identity-established (anonymous tools plus `get_principal`) instead of being denied everything, while an unreachable record fails spend with retryable `SERVICE_UNAVAILABLE` and keeps reads bound; a self-operated brand may grant the signer's operator directly; and a principal-resolver failure after successful verification is delivered as a standard AdCP error instead of a 403 with `Accept-Signature`.
