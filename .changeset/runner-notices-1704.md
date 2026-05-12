---
"@adcp/sdk": minor
---

Add structured `notices: RunnerNotice[]` advisory surface to `StoryboardResult` and `ComplianceResult` (adcp-client#1704).

- New types: `RunnerNotice`, `NoticeCode`, `NoticeSeverity` — exported from `@adcp/sdk`
- `StoryboardResult.notices` is always-present (default `[]`); `ComplianceResult.notices` is optional, deduplicated by `code` across all storyboard runs
- Two spec-grounded notices emitted on day one:
  - `request_signing_required_in_4_0` (`future_required`) — when the `signed_requests` storyboard runs against an agent that lacks `request_signing.supported: true` (signing required for spend-committing operations in AdCP 4.0)
  - `legacy_hmac_fallback_removed_in_4_0` (`deprecation`) — when agent declares `webhook_signing.legacy_hmac_fallback: true` (removed in AdCP 4.0)
- CI gates and JUnit consumers can now key on stable `code` values for badge routing instead of parsing prose `skip.detail` strings
