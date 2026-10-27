# SDK 16 stable adoption fixes

The SDK keeps its AdCP 3.2.7 pin and existing legacy HTML mapping. New APIs are
additive: `parseMediaBuyDeliveryWebhook`, the shared delivery report body/schema,
canonical `AssetVariant` exports, and targeting overlay key arrays. The standalone
parser accepts authenticated bytes and validates the trusted caller-selected
release; existing `verifyAndParseWebhook` return contracts are unchanged.

Account-sync results retain `account`, `operator_unit`, `revision`,
`identity_change`, `identity_change_preview`, `currency`, and `timezone`.
`SyncAccountsResultRow` remains an interface with required legacy
`brand`/`operator`/`status` fields, so existing extending interfaces and read-side
wrappers keep compiling. A 3.2 `account` reference takes precedence over the flat
wire anchor; 3.0 and 3.1 retain the flat fields. The modern account-only result
union is an SDK 17 migration. Adopters serving multiple releases should select
result identity using `ctx.servedAdcpVersion`.

The entire `destination_billing_entity` is request-only. Its name and tax data
are stripped along with bank details and framework auth/context metadata before
responses or replay caching. Nested account and operator identity objects use
closed protocol schemas and are emitted as detached validated snapshots.

Global daypart-union and nonempty Zod output tightening stays on SDK 17. The
shared stable report body reflects the existing tolerant poll Zod output;
version-aware delivery parsing uses strict authoritative JSON schemas.
