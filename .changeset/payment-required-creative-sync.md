---
'@adcp/sdk': patch
---

Allow `sync_creatives` on `payment_required` accounts under the `auto` and `strict` account policies. Keep blocking spend commitments on these accounts and refusing creative sync on pending, suspended, rejected, or closed accounts. Correct the first-call guide to describe this distinction.
