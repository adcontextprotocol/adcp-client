---
'@adcp/sdk': patch
---

Preserve product and signal mirrors when wholesale refreshes fail, emit typed AdCP error details, and retry degraded mirrors during polling (#3092). WholesaleFeedSyncState now includes `degraded`; exhaustive state switches should handle it.
