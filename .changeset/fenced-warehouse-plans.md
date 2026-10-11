---
'@adcp/sdk': patch
---

Atomically claim BigQuery warehouse batches and fence retry attempts and cursor commits during overlapping runs. Keep reporting feed checkpoints from moving backward within the same feed scope, and preserve retention gaps across initial startup retries. Order feed pages by numeric sequence and transaction values so pagination cannot skip or replay changes at decimal boundaries. Check replayed BigQuery jobs in the same project as the load destination.
