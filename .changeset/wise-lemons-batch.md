---
'@adcp/sdk': patch
---

Run ordinary local Node test discovery in bounded fresh-process batches so test heap usage is reclaimed between batches while focused runs and CI shards retain their existing execution shape.
