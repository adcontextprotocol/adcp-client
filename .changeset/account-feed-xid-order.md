---
'@adcp/sdk': minor
---

Reliable Reporting: the account change feed now orders by `(xid, seq)` behind `xid < pg_snapshot_xmin(pg_current_snapshot())`, as the deployment-wide feed already did (#3283). The feed no longer depends on the account lock to keep `seq` in commit order, and the in-flight truncation guard from #3228 is gone. A change with a lower `seq` and a higher `xid` that commits late is returned on a later page, after the cursor, instead of being skipped. This is an `@experimental` surface, so the break ships as a minor.

**Migration note.**

- Re-apply `REPORTING_LEDGER_CHANGES_MIGRATION` before starting the new binary. It is idempotent. It adds `pruned_through_xid` and `pruned_through_xid_seq` to `adcp_reporting_change_account_horizon`, replaces the `adcp_reporting_feed_consumers` check constraint (an account consumer may now carry an `xid`, and a pre-upgrade account row keeps a NULL one), creates the `adcp_reporting_changes_account_xid (account_id, xid, seq)` index, and takes an advisory lock so concurrent appliers cannot race. The old `adcp_reporting_changes_account (account_id, seq)` index is left in place; drop it once no older host runs.
- Account cursors now carry `xid` (`{ v, account, seq, xid }`). Consumers store the cursor string opaquely and need no change.
- An account cursor saved before the upgrade (`seq` only) is accepted. `changesAfter` maps it to `(xid, seq)` with `xid` the smaller of the oldest `xid` among the account's changes after that `seq` and the reading snapshot's `xmin`. Every later change has an `xid` at or above both, so none is skipped. A few changes the consumer already read, those with a lower `seq` and a higher `xid`, can be returned again, so consumers must treat redelivery as normal. The returned cursor is in the new format. A legacy cursor fails closed with `CURSOR_EXPIRED` (resynchronize from `listCurrentRevisions`) if any change with a higher `seq` was pruned. A consumer registration saved before the upgrade holds retention by `seq` until its next `saveFeedConsumerCursor`.
- `pruneChanges`, `retireExpiredPeriods` and snapshot compaction now hold a change for an account consumer until the consumer has passed it in `(xid, seq)` order. BigQuery sinks need no change: their saved account cursor is upgraded on the next batch.
- Any older open transaction on the cluster now holds the account feed back, as it already held the deployment feed. An empty page means caught up or held back.
