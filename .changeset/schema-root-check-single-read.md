---
'@adcp/sdk': patch
---

Make external schema-root checks cheaper. `registerExternalSchemaRoot`, `withExternalSchemaRoot` and `withServedReleaseSchemaRoots` walked and fully loaded every document of the root two or three times per call to read top-level `$id` and `$schema` (about 0.9 s of CPU for a 150 MB release). They now read each document once per call, and they reuse what they read from an unchanged on-disk document (same inode, size, mtime and ctime, last changed more than 3 s ago) across calls and across the ESM and CommonJS builds. A repeated check of an unchanged root costs a directory walk and one `stat` per file. Results, thrown errors and their messages are unchanged; archive-backed bundled entries are still read the way they were.
