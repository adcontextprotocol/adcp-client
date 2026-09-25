---
'@adcp/sdk': patch
---

Make deployment-wide Managed Delivery planning durably fair across reporting accounts. PostgreSQL now persists a round-robin cursor and gives each selected account a bounded first-pass share before a hot tenant can consume spare capacity, so later and newly added accounts cannot be starved by the lexically first account.
