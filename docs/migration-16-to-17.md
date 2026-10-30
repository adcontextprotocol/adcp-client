# Migrating from SDK 16 to 17

SDK 17 beta pins the signed AdCP `3.3.0-beta.2` release. Use the beta in
development and staging; production remains on SDK 16 and AdCP 3.2.

## Companion packages

The next release pairs **`@adcp/sdk@17.0.0-beta.2`** with
**`@adcp/reporting-storage@0.3.0-beta.1`**. The storage package requires SDK
`^17.0.0-beta.2`; install and lock both packages together after publication:

```bash
npm install --save-exact @adcp/sdk@17.0.0-beta.2 @adcp/reporting-storage@0.3.0-beta.1
npm ls @adcp/sdk @adcp/reporting-storage
```

The `beta` tags select that release train once published. Stable storage
`0.2.0` accepts SDK `^16.5.0`, including SDK 16.6; it does not accept SDK 17.
The earlier SDK 17 beta.0/beta.1 pair used storage `0.2.1-beta.0`, whose code
and SQL migrations matched `0.2.0` and whose peer range was `^17.0.0-beta.0`.
A stable range such as `~0.2.0` does not select either storage prerelease.

Storage `0.3.0-beta.1` also includes reporting configuration history. Reapply
`REPORTING_LEDGER_MIGRATION` before starting the new workers: it adds the
nullable `adcp_reporting_configurations.history_start` audit column and
live-priority indexes idempotently. Upgrade all workers before granting or
extending historical ownership. Existing configurations retain their original
history boundary until the trusted host explicitly changes it. See the
[reporting ledger guide](./guides/REPORTING-LEDGER.md) for history, source
retention, pacing, and custom-store requirements.

If upgrading from SDK 16.4 or earlier, also read the
[storage 0.2.0 notes](https://github.com/adcontextprotocol/adcp-client/blob/main/packages/reporting-storage/CHANGELOG.md#020)
for BigQuery sinks that omit `location`.

## Added union and enum members

These additions are relative to the bundled AdCP 3.2.7 contract. Update exhaustive
switches and runtime accept-lists deliberately; the unversioned `*Values` arrays
always describe the SDK's current pin, not the negotiated seller release.

| Surface | Added members or requirement | Migration action |
| --- | --- | --- |
| Account notification types | `collection_card.updated`, `collection_card.removed`, `collection_catalog.bulk_change`, `proposal.created` | Add handlers or explicitly exclude them from subscriptions. `ACCOUNT_NOTIFICATION_TYPES` includes all four. |
| `OutcomeTarget.goal.kind` | `vendor_metric` | Narrow all three goal kinds before accessing `metric`; see below. |
| `UniversalMacroValues` | `ADDTL_CONSENT` | Review macro accept-lists. Parameterized `GDPR_CONSENT_<gvl_id>` names also remain valid; the finite runtime array does not enumerate them. |
| Delivery `metric_id` / `AvailableMetric` | `print_metrics`, `publication` | Handle print-specific delivery aggregates. |
| `DemographicSystem` | `nmo`, `videoamp` | Review audience and demographic system filters. |
| Price adjustment `kind` | `operator_fee` | Include operator fees in supported price adjustment handling. |
| Seller-originated account changes | Nonempty `changed_paths` for `origin.kind: 'adcp'` or `'seller_operator'` | Populate paths on 3.3 pages. This is not required on 3.2 pages. |
| Creative asset content types / format slots | `video_brief` | Accept generation briefs separately from finished video assets. |
| Canonical format option kinds | `seller_rendered_stateful_display`, `coordinated_placements` | Update format-kind switches. |
| `PrincipalChangedWebhook.reason` | `relationship_changed`, `relationship_expiring` | Refresh relationship state when these invalidations arrive. |
| Product card asset `role` | `sample_content` | Update card-reference rendering switches. |
| Wholesale feed `entity_type` | `collection` | Handle collection invalidations; the feed event and webhook type unions include the three collection events above. |
| `ErrorCode` | `CREATIVE_MERGE_REJECTED`, `ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT`, `RIGHTS_CHANNEL_VIOLATION` | Handle the advertised recovery behavior; do not assume every new code is transient. |
| `IndicatorType` | `flight_extension_opportunity`, `scale_budget_opportunity` | Update indicator filters and displays. |
| `PixelTrackingEvent` | `start`, `first_quartile`, `midpoint`, `third_quartile`, `complete` | Review tracking event accept-lists. |
| Refinement action | `extend_hold` | Handle explicit hold extension. |
| `Specialism` | `sales-fixed-rate` | Include fixed-rate sellers in capability classification. |
| Canonical hosted-video codecs / containers | `mpeg2`, `avc_intra`, `xavc` / `mxf` | Update media validation and ingest routing. |
| Brand identity requested / available fields | `collections` | Handle collection identity fields if requested. |
| Creative listing fields | `provenance` | Include provenance only when requested and authorized. |
| Signal listing fields | `age_determination_bases`, `signal_status`, `source_audience_id` | Update field-selection lists. |
| Account change repair task / lifecycle tools | `list_proposals` | Refresh proposal state for relevant invalidations. |
| Event-source sync row action | `archived` | Handle archived source readback. |
| Entity hydration types | `creative_seller_revision`, `governance_budget_period` | Update entity type routing if used. |
| Agent permission denial reason | `grant_absent` | Handle missing grants in permission diagnostics. |
| Compliance controller operation | `mutate_definition` | Available to test-controller scenarios. |

`OutcomeTarget.goal` is now `metric | event | vendor_metric`. After excluding
`event`, a value can still be `vendor_metric`, which has `vendor` and `metric_id`
instead of `metric`. On proposal requests and refinements, sellers declaring
outcome-target planning but supporting only delivery metrics should reject
unsupported goals with `INVALID_REQUEST` naming `criteria.outcome_target.goal`.
A vendor goal requires the product's declared vendor/metric pair and a cumulative
total. Sellers that do not declare outcome-target planning reject the field
with `UNSUPPORTED_FEATURE`. On `list_products` the field is inert: perform schema
validation but do not reject it merely because the goal is unsupported.

## Public asset and targeting types

Import the shared `AssetVariant` union from `@adcp/sdk`, `@adcp/sdk/types`, or
`@adcp/sdk/schemas`. Per-tool type slices stay self-contained and expose the
same structural contract. `AssetVariantSchema` has an explicit `z.ZodType`
annotation to keep `z.output<typeof AssetVariantSchema>` shallow and assignable
to that union, including nonempty video-brief segments and macro declarations.

`DaypartTarget` is a union of complete whole-hour and minute-resolution forms.
Check `start_hour !== undefined` before using hour arithmetic; minute windows
use `start_time` and `end_time` and can cross midnight. Mixing the forms or
omitting either endpoint is a type error.

`TargetingOverlayKeys` and `TargetingOverlaySupportKeys` are frozen runtime key
arrays exported from `@adcp/sdk` and `@adcp/sdk/types`. They include
`collection_lists`, `collection_lists_exclude`, and extension fields. Use them
for exhaustive dimension handling instead of maintaining local copies.

`streamAccountChanges` validates each page using trusted negotiated/wire
metadata before any seller echo. Without authoritative release metadata, the
drain falls back to the seller echo and then the client's configured version. Custom
readers can pass `adcpVersion: '3.2.7'` in the drain options. This selects
validation only; the reader remains responsible for sending the matching
request release. Existing cursor, account identity, and acknowledgement checks
still apply.

A `3.3.0` or `3.3` configuration pin does not select a beta. Use the exact
`3.3.0-beta.2` bundle (wire alias `3.3-beta.2`); unavailable pins now produce a
short list of bundled release lines instead of every compatible patch.

## pnpm peer resolution

The official A2A SDK `1.0.1` already marks its Express peer optional, and the
AdCP SDK marks OpenTelemetry optional. AdCP cannot change a transitive package's
peer metadata by adding an Express entry to its own manifest. pnpm can still
create multiple SDK instances when workspace importers supply different peer
versions or different optional-peer sets. Install one compatible peer set at
the workspace root and align it across importers.

For workspaces that need explicit convergence, declare the three packages as
direct root dependencies, then use their declared specs in `pnpm-workspace.yaml`:

```yaml
dedupePeerDependents: true
resolvePeersFromWorkspaceRoot: true
overrides:
  '@a2a-js/sdk': '$@a2a-js/sdk'
  '@modelcontextprotocol/sdk': '$@modelcontextprotocol/sdk'
  '@opentelemetry/api': '$@opentelemetry/api'
```

Choose versions satisfying all consumers before applying overrides; they do not
make incompatible peer contracts compatible. Run `pnpm install`, `pnpm dedupe`,
and `pnpm why -r @adcp/sdk` to inspect the resulting graph. See
[pnpm's dependency-resolution settings](https://github.com/pnpm/pnpm/blob/main/pnpm/docs/settings/dependency-resolution.md)
and [peer-dependency settings](https://pnpm.io/settings#dedupepeerdependents).

## Protocol and discovery

The SDK packages the exact 3.3 beta schema and compliance bundle alongside
maintained AdCP 3.2.7, 3.1.29 and 3.0.25 bundles. A seller must advertise
`3.3-beta.2` (or its full bundle version, `3.3.0-beta.2`) before the buyer
selects that preview. A different beta, a moving `3.3-beta` alias, or a
served-version echo alone does not establish support. The buyer can negotiate
an older stable release the seller advertises. Missing or synthetic capability
evidence cannot authorize a preview request.

`AgentClient` and `SingleAgentClient` expose `listCollections()` and
`listProposals()`, including typed completion handlers. The corresponding
server handlers are `mediaBuy.listCollections` and `mediaBuy.listProposals`,
or optional methods on `MediaBuyLifecyclePlatform`. Their synchronous results
use `outcome` and do not acquire a synthetic task `status` field.

## AdCP 3.3.0-beta.2

SDK 17 now pins AdCP `3.3.0-beta.2` and no longer packages or advertises
`3.3.0-beta.1`. Preview negotiation is exact, so a beta.1 seller and a beta.2
buyer settle on a stable release they share, and an explicit
`adcpVersion: '3.3.0-beta.1'` pin fails with a configuration error. Upgrade
both sides together when you test preview-only features.

- **Withdrawn from 3.3 (adcp#8537).** Definition pins
  (`commercial_terms.definition_pins[]`, `DefinitionPin`, the
  `REFERENCE_DEFINITION_CHANGED` error code, the `definition_changed`
  refinement reason and `drifted_pins[]`), purchase rights
  (`purchases[].rights[]`, the `paid_amplification` and `content_reuse` right
  uses) and installment selection (`purchases[].installments[]`,
  `installment_changes`, `unsatisfied_installment_changes`) are gone from the
  types and schemas. Remove any code that builds or reads them, and stop
  listing `media_buy.purchase_rights` and `media_buy.installment_selection` in
  `experimental_features`. Installments on canonical products and the `holds[]`
  readback remain.
- **Account changes as a separate account.** `requestAccount()` accepts
  `allow_separate_account` (default `false`). A change request may resolve as
  `created` (a separate account carrying the change, only with the opt-in) or
  `matched` (an account the caller already holds); in both cases the resolved
  `account_id` differs from `requested.account_id` and the named account is
  unchanged. Without the opt-in, a seller that would take the change only on a
  new account returns `ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT` (correctable).
- **Seller offers (experimental `media_buy.seller_offers`).** Canonical
  proposals carry `proposal_initiator`, `list_proposals` rows carry
  `offer_reason`, and `proposal.offered` is a notification type.
- **Measurement provenance (experimental `media_buy.measurement_provenance`).**
  `CollectionMechanism`, `measurement_terms.billing_measurement.counting_mechanisms[]`
  and delivery `vendor_metric_provenance[]` are typed.
- **Reporting subscriptions.** Offerings gain `standard_dimensions` and
  `unmapped_dimensions`; `subscription_coverage.excluded[]`, `gaps[]` and
  `timezone_cutovers[]` entries may carry `offering_id`; subscription readbacks
  carry `prior_versions[].configuration` and `inactive_intervals`.
- **Deprecations.** `principal_kind` / `expected_principal_kind` on the
  principal tasks are deprecated; a bound buyer agent is always `buyer_agent`.

## AdCP 3.3.0-beta.1

SDK 17 beta.5 through beta.9 pinned AdCP `3.3.0-beta.1` and no longer packaged or advertised
`3.3.0-beta.0`. Preview negotiation is exact, so a beta.0 seller and a beta.1
buyer settle on a stable release they share. Upgrade both sides together when
you test preview-only features.

- **Account requests (experimental `account.requests`).** `requestAccount()`
  opens an account (`brand` + `operator`) or, with `account_id` plus fields,
  requests a change. Send `revision` when changing `billing`, `billing_entity`
  or `payment_terms`; a stale revision returns `CONFLICT`. A completed change
  resolves with `resolution: 'updated'`. Send `request_id` to pick a candidate
  from an `ambiguous` request. Read requests back with
  `listAccounts({ include_requests: true })` or `request_ids`; requests page
  through `requests_pagination` / `account_requests_pagination`, independent of
  the account `pagination`. There is no `get_account_requests` task.
  `sync_accounts` stays stable. Servers can register a raw
  `accounts.requestAccount` handler; the decisioning platform (`definePlatform`)
  has no `request_account` hook yet.
- **Media-buy issues.** `reportMediaBuyIssue()` and `getMediaBuyIssue()` cover
  `media_buy.issue_reporting`. Servers can register raw `mediaBuy` handlers.
- **Reporting subscriptions (experimental `media_buy.reporting_subscriptions`).**
  The `sync_principal` / `get_principal` `reporting_subscriptions` section,
  `get_reporting_status` `subscription_coverage`, `configuration_tasks`, and
  `account.authorization.authorized_at` are typed. The built-in principal
  runtime does not implement subscriptions and answers a submitted
  `reporting_subscriptions` section with `UNSUPPORTED_FEATURE`.
- **Type changes.** `DemographicTargetingIntent.age` is optional because 3.3
  adds gender-only targeting; narrow it before reading. Product
  `publisher_properties` and `collections` may be empty arrays, which mean an
  undisclosed roster rather than an empty one.

## Postgres replay store

`PostgresReplayStore` inserts through a table-specific guarded function
(`<table>_insert_guarded`) that keeps the replay check, the per-key cap and the
insert on one backend. A database created by an earlier SDK has the table but
not the function. Every insert then fails with "PostgresReplayStore database
migration is outdated", and signed requests answer 503 (Web Bot Auth) or are
refused. Rerun the migration for each replay table before deploying SDK 17:

```ts
import { getReplayStoreMigration } from '@adcp/sdk/signing/server';

await pool.query(getReplayStoreMigration('adcp_replay_cache')); // your table name
```

The migration is idempotent. If you manage schema with numbered migration
files, add a new file with the current `getReplayStoreMigration()` output; a
file copied from an older SDK does not create the function.

## Account resolution and optional declarations

On a served AdCP 3.3 route, buyer-supplied account references require a
reference-aware resolver. Unresolved references return `ACCOUNT_NOT_FOUND`
before the handler runs, even when `strictAccountReferences: false` was set
for an older compatibility route. `list_accounts.account` is a filter.
Discovery and negotiation resolvers receive `provisioning: false`; they must
not create or activate accounts or accept billing terms.

The generated types and validators include the beta's optional catalog
ingestion, onboarding, DOOH location/inventory, audience-size, collection,
proposal and creative declarations. If a seller declares `catalog_ingestion`,
its handlers must enforce the advertised types, modes, formats and limits
before mutation. Review fields that previously used an open extension name:
`catalog_ingestion` now has an object schema, and `ext.adcp` is reserved.

Asset unions gain `video_brief`; update exhaustive switches. The experimental
build-creative evaluator agent form uses `agent_url` instead of `evaluator_id`.
Provide an allowlisted evaluator URL explicitly; an opaque old evaluator ID
cannot be converted into a trustworthy URL by the SDK.

The `@adcp/sdk/identity-3.3` and Web Bot Auth opt-in remains experimental.
Changing the protocol pin does not enable that opt-in or graduate its APIs.
Existing RFC 9421 signing and verified agent-resolution checks remain active.

## HTML-markup formats use inline-markup display tags

The AAO legacy formats `display_html` and `display_WxH_html` accept HTML
markup rendered by the seller. SDK 17 projects them to canonical `display_tag`
with `supported_delivery_types: ['inline_markup']`. The previous `html5`
classification described a zip bundle and prevented correctly classified
third-party markup from matching these formats.

If your application created `html5` creatives containing an `html` snippet for
these formats, change the creative to `format_kind: 'display_tag'` and send its
markup as an inline-markup asset:

```typescript
const asset = {
  asset_type: 'display_tag',
  delivery_type: 'inline_markup',
  markup_type: 'standard',
  markup: legacyHtmlAsset.content,
};
```

Use the seller's declared slot, typically `html_creative`. Explicit
`format_parameters.width` and `format_parameters.height` take precedence when
selecting among multiple sizes. AdCP 3.3 also carries rendered dimensions on
`zip`, `html`, and `display_tag` assets; when `format_parameters` is absent,
the SDK uses one unambiguous rendered asset size.

Update code branching on `resolveCanonicalFormatKind` or
`canonicalDeclarationFromBareId`: `_html` IDs now resolve to `display_tag`,
including when the local `assetType: 'html5'` hint selects an `_html` ID.
Actual zip creatives remain `html5` and cannot match HTML-markup-only products.

Legacy delivery preserves the seller's format URL and size and emits the markup
bytes in `html_creative.content`. The rendered `width`, `height` and `sizes` are
AdCP 3.3 asset fields, so they are not copied onto the legacy `html` asset: the
selected `display_WxH_html` ref carries the size. Sellers on 3.3 get the
canonical `display_tag` with those fields. Tag URLs and inline markup select only legacy
refs that accept their delivery type. A paired redirect or inline-markup creative
cannot use a ref that accepts only tag URLs. Multi-size tag-URL declarations keep
their seller-asserted refs rather than expanding into inline-markup HTML formats.
This applies to every unsized representative ref: without a size-bearing ID,
the SDK cannot establish a catalog family for expansion and retains the
`FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE` diagnostic.

When a seller publishes a standard format ID under its own creative-agent URL,
the SDK preserves that URL and converts inline markup to legacy HTML. It keeps
the asset keys unless an exact or caller-supplied format definition identifies
the seller's slots; a matching bare ID alone does not establish those slot names.

The legacy HTML asset has no field for `macro_declarations`. SDK 17 refuses that
conversion before dispatch; deliver creatives with declared macros through the
canonical `display_tag` contract. Legacy HTML also has no `markup_type` field;
when converted for a canonical request, its markup type defaults to `standard`. Existing legacy
request assets remain unchanged on the legacy wire. Explicit seller declarations
retain their format kind and delivery types. In dual-emitted products, an old
`html5` option paired with a `display_*_html` ID does not erase valid pairings
for sibling image/video options. The incompatible HTML option is left unpaired;
fix that seller declaration to `display_tag` with inline-markup delivery before
using it. The SDK does not reinterpret a seller's declared zip contract.

These changes follow [adcp#8339](https://github.com/adcontextprotocol/adcp/issues/8339)
and [adcp#8357](https://github.com/adcontextprotocol/adcp/pull/8357). They use the
existing inline-markup display-tag contract. This mapping changes public
helper return values and projected creative wire shapes, so it ships in the
SDK 17 major release. SDK 16 keeps its existing HTML-markup mapping.

On 3.3 routes, the server automatically advertises the required experimental feature IDs for registered handlers: `list_collections` adds `media_buy.collection_catalog` and `media_buy.collection_cards` and `list_proposals` adds `media_buy.open_opportunities`. These APIs remain experimental in the protocol beta.

Account verification applies to the selected request release. Unversioned callers select the server default, now the 3.3 beta. On 3.3 routes, `required_for_products` enforces `ACCOUNT_REQUIRED`; set `strictAccountReferences: true` to apply the same policy to older routes. Proposal discovery always requires an authenticated caller and a resolved account, including when schema validation is off.

The direct governance helpers and governance middleware retain their configured client protocol pin. For a stable governance agent, use a client configured with `adcpVersion: '3.2.7'`; `syncPlans` and `getPlanAuditLogs` also accept an explicit `wireAdcpVersion` in their task options. Per-agent negotiation for these direct governance paths remains follow-up work.

AdCP 3.3.0-beta.2 withdraws definition pins, purchase rights and installment selection from 3.3 (adcp#8537); they return through a `commercial_terms` extension point in 4.0. The verifier reads this from the selected schema: against beta.2, `definition_pins` and purchase `installments[]` / `rights[]` are unknown fields that the closed `commercial_terms` rejects, and publisher format references and placement, collection or signal targeting compare as ordinary snapshot terms. A snapshot verified against a retained beta.0 or beta.1 schema root still fails closed on definition pins and the references they covered, because that release required current-source pin verification. The verifier enforces collection-list uniqueness by reference identity.

AdCP 3.3 snapshot rules that need data the snapshot does not carry: the verifier fails closed on SLA windows that name a `business_calendar_id` (business-clock SLAs resolve against capability calendars). Elapsed-clock SLA windows verify normally. Against a retained beta.1 schema root it also fails closed on purchase `installments[]`. For `price_adjustments`, the accepted snapshot deliberately omits the discovery-time table, so the verifier checks schema validity and `pricing_option_id` identity but does not re-resolve `pricing.fixed_price`; a buyer holding the table must resolve it before accepting.

For AdCP 3.0 buyers, `create_media_buy` and `update_media_buy` responses move
`media_buy_status` back into lifecycle `status` before schema projection. A buy
waiting on creatives therefore returns `status: 'pending_creatives'`; 3.1+
responses keep task `status` separate from `media_buy_status`.

This projection applies to responses the framework emits. A webhook your
platform builds itself from a copy of the response, such as an inline completion
callback to a 3.0 buyer, does not pass through it. Apply the same mapping so the
webhook `result` matches the buyer-visible response: for a 3.0 buyer, carry the
media buy status as `status` and omit `media_buy_status`. A test comparing the
webhook `result` with the synchronous response catches drift. Exporting the
projection for seller-emitted webhooks is tracked in #3475.

## Receivers with their own delivery webhook verification

`parseMediaBuyDeliveryWebhook` from `@adcp/sdk/webhooks` validates an already
authenticated body at a trusted `adcpVersion`, with readable envelope/result
errors and an explicit, marked `acceptBareDeliveryReport` compatibility option.
The registered reporting-delivery branch of `verifyAndParseWebhook` delegates
to it and accepts a per-call `adcpVersion` for stored buy contracts.

Use `MediaBuyDeliveryReportSchema` and `MediaBuyDeliveryReport` for one polled
and pushed ingestion shape without fabricating task status. Full poll response
schemas keep the status required by their referenced protocol envelope;
`MediaBuyDeliveryWebhookResultSchema` now enforces required `by_package` rows.
See [Parsing media-buy delivery webhooks](./guides/DELIVERY-WEBHOOK-PARSING.md).

Registered reporting receivers now distinguish `webhook_result_invalid` from
`webhook_envelope_invalid`, and use `webhook_unsupported_payload` for another
task type or a bare report. Update exhaustive code switches accordingly.
Invalid reporting schema configuration returns `webhook_verification_unavailable`
before consuming a nonce. Routing metadata uses the trusted registration's
operation ID; the seller's original ID stays in the validated envelope.

Zod schemas now enforce protocol-authored `minItems` bounds throughout, including
nonempty creative segments and render-guidance positions. Correct previously
accepted empty arrays where the protocol requires at least one item; nonempty
array output types are now `[T, ...T[]]`.

## Account identity in sync results

`accounts.upsert` results now preserve `account`, `operator_unit`, `revision`,
`identity_change`, `identity_change_preview`, `currency`, and `timezone` (#3466).
`SyncAccountsResultRow` declares these fields. For 3.2+ settings updates, return
`account` as the identity anchor and omit flat `brand`/`operator`; provisioning
results use the natural key. Older releases still require the flat pair. Failed
3.2+ rows may omit `status` when the account state could not be determined.

The entire `destination_billing_entity` is request-only and is stripped from
responses, including its legal name and tax details. This differs from the
current `billing_entity`, whose non-bank metadata is returned while `bank` is
stripped. The rule applies both to framework `accounts.upsert` projection and
the raw account response builders before replay caching.

Consumers reading `SyncAccountsResultRow` should narrow the identity anchor and
check failed rows before assuming `brand`, `operator`, or `status` are present.
The type now rejects missing or mixed identity anchors and successful rows
without a lifecycle status.

Nested account and operator identity objects must conform to their closed
protocol schemas. Internal fields accidentally retained from a request or DB
record are rejected before response emission, even when whole-response
validation is off.

`SyncAccountsResultRow` is now a union type. Replace interface extension with
an intersection alias such as `type MyRow = SyncAccountsResultRow & { upstreamId?: string }`.
Identity objects are emitted as detached validated snapshots. Raw account
response builders also strip top-level `authInfo` and `ctx_metadata`.
