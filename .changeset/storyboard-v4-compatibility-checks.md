---
'@adcp/sdk': major
---

Implement the storyboard `all_fields_present` check, reporting missing or null fields with RFC 6901 pointers and treating absent, null, or empty arrays as not observable. Emit the canonical `request_signing_required_in_4_0` and `legacy_hmac_fallback_removed_in_4_0` notice codes in place of the dotted spellings, preserving their trigger conditions, severities, and effective version.

Breaking: `NoticeCode` replaces `request_signing.required` with `request_signing_required_in_4_0` and `webhook_signing.legacy_hmac_fallback.removed` with `legacy_hmac_fallback_removed_in_4_0`. Update TypeScript literal comparisons and dashboard keys to use the canonical codes.
