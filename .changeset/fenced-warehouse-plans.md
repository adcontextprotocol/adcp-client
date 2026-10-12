---
'@adcp/sdk': minor
---

Atomically claim BigQuery warehouse batches and fence retry attempts and cursor commits during overlapping runs. Order feed pages by numeric sequence and transaction values so pagination cannot skip or replay changes at decimal boundaries. Check replayed BigQuery jobs in the same project as the load destination.

Reporting feed checkpoints now move forward only within a feed scope: `saveFeedConsumerCursor` ignores a cursor behind the saved one. It now resolves `true` when it wrote the checkpoint and `false` when it ignored it (it previously resolved `void`), and accepts `{ rewind: true }` to move a consumer back deliberately, for example to replay changes. A host that rewound consumers by saving an older cursor must pass `rewind: true` or it keeps the newer retention hold. New `removeFeedConsumer(name)` unregisters a consumer.

A `changesAfter` read with no cursor can throw `ReportingChangeCursorExpiredError` (`code === 'CURSOR_EXPIRED'`) when a prune commits mid-read; handle it on first reads as on saved cursors, and match on `error.code` rather than `instanceof`. The BigQuery sink now keeps a failed first read's start position across restarts so the retention gap stays reported, matches the expiry by code (so CJS and ESM module copies behave the same), and gains `sink.reset()` to clear a sink that keeps rejecting with `CURSOR_EXPIRED`, such as a new sink that lost a startup race with pruning. New `ReportingChangeCursorExpiredError.cursor` carries the original feed position.
