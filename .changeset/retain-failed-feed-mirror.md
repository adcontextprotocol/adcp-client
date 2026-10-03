---
'@adcp/sdk': minor
---

Preserve product and signal mirrors when wholesale refreshes fail, emit typed AdCP error details, and retry degraded mirrors during polling (#3092). WholesaleFeedSyncState now includes `degraded`; exhaustive state switches should handle it.

Manual refresh and webhook repair reject failed catalog reads, preserving the mirror and leaving failed deliveries eligible for retry.
