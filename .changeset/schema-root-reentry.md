---
'@adcp/sdk': patch
---

Keep compiled validators when an unchanged schema root is entered again. `withExternalSchemaRoot` and `registerExternalSchemaRoot` dropped every loader state of the version on each call, so a storyboard runner that enters the same root once per storyboard recompiled the whole validator set every time. A call now keeps the states and the loader generation when the root was already entered for the version since the states were last cleared and every document in it is unchanged: same paths, and the same inode, size, mtime and ctime, all older than 3 s. A rewritten, freshly written or other root, or an unregister, starts a fresh epoch as before. Root checks also resolve version aliases once per distinct `$id` version rather than once per document.
