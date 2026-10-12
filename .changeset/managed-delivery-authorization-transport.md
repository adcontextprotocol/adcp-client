---
'@adcp/sdk': minor
---

Managed Delivery destination authorizations now record the delivery `pattern` and `transport` they serve. `ReportingDestinationAuthorizationV1` and the `adcp_reporting_destination_authorizations` table gain optional, immutable `pattern` and `transport`; pass them to `authorizeDestination()` when a generation is created and `claimRevocation()` hands them to `adapter.revoke()`, which is what lets a host route a revocation to the transport that holds the provider grant. A replay of the current generation may omit them but can never state a different value, and `installBinding()` rejects a binding whose `method`/`transport` differ from what its generation recorded.

`REPORTING_MANAGED_DELIVERY_MIGRATION` stays additive and safe to re-run. The first run that adds the columns also backfills each existing generation from the bindings that reference it, only where every such binding names the same method and the same transport; a generation whose bindings disagree, name no transport, or do not exist stays NULL. The migration raises a `NOTICE` with the count it left NULL, and the new `PostgresReportingManagedDeliveryStore.listDestinationAuthorizationsWithoutContract()` lists them with the reason.
