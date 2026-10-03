---
'@adcp/sdk': patch
---

Resolve implicit accounts by their complete natural key and refuse unsynced references (#3091). Add opt-in additive `mergeOnUpsert` with `remove(ref, ctx)` and `delete_missing` support. Keep the 24-hour TTL and replacement default for compatibility.
