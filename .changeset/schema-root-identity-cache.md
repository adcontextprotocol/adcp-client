---
'@adcp/sdk': patch
---

Persist what schema-root checks read in the `ADCP_VALIDATOR_CACHE_DIR` cache. A process's first check of a root still parsed every document (about 1,700 files and 150 MB per release root), and storyboard processes check several roots each. With the cache directory set, a check of a fully settled root stores each document's stat key and top-level `$id` and `$schema`; a later process uses a stored record only while the document's inode, size, mtime and ctime are unchanged, the same rule as the in-process cache, and parses everything else. Results, thrown errors and messages are unchanged.
