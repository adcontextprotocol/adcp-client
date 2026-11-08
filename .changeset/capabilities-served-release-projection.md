---
'@adcp/sdk': patch
---

`createAdcpServer` and `createAdcpServerFromPlatform` now project `get_adcp_capabilities` down to the release they serve a 3.1 or 3.2 caller, as DR-0024 requires (#3646). Before, those callers received 3.3-only capability fields because the older capabilities schemas are open, and the server removed only fields where an older schema is closed.

- **Fields.** The response gets the same schema diff that every other task response gets on the way down: properties, enum values and union variants that the server's release declares and the served release does not are removed at every depth. This covers `business_calendars`, `media_buy.issue_reporting`, `media_buy.open_opportunities`, `media_buy.supported_match_keys` and `account.requests`. Keys that no release declares are kept, for example `library_version` or a seller's own extension key.
- **Experimental feature ids.** `experimental_features` drops an id that the server's capabilities schema names and the served release's schema never mentions, such as `media_buy.match_keys` for a 3.2 caller. AdCP has no structured registry of experimental feature ids yet (adcontextprotocol/adcp#8812), so ids that neither schema mentions are kept.
- **Reporting.** Every removal, including each dropped feature id, is reported to `onVersionTranslation` as `version_downgrade_fields_dropped` drift.

Responses to 3.3 callers are unchanged, and 3.0 callers keep the existing allow-list projection to the 3.0 schema.
