---
'@adcp/sdk': patch
---

Atomically claim BigQuery warehouse batches and fence retry attempts and cursor commits during overlapping runs. Keep reporting feed checkpoints from moving backward within the same feed scope.
