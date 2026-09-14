# Adopting the account change feed

The account change feed is an optional AdCP 3.2 capability. Existing generated
`listAccountChanges()` methods, request/response types and notification enums
remain the raw wire API. The SDK now adds `streamAccountChanges()`,
`parseAccountChangeNotification()` and `buildAccountChangeSubscriptionRequest()`
(with `normalizeAccountChangeNotification` as an alias of the parser)
on `@adcp/sdk` and `@adcp/sdk/client`; the parser is also available from
`@adcp/sdk/webhooks`.

The **webhook is a wake-up**. The feed contains ordered invalidation metadata.
Authoritative repair reads return current truth, including changes made by a
seller operator, another authorized buyer or a connected platform. A change
record is neither a historical resource snapshot nor an executable instruction.

## Discover and register

```typescript
import { buildAccountChangeSubscriptionRequest } from '@adcp/sdk';

const caps = await agent.getCapabilities();
const feed = caps.account?.changeFeed;
if (!feed?.supported) throw new Error('Seller does not support account changes');
// feed retains the published read_task, registration_task, event_type,
// retention_days and resource_types fields.

const result = await agent.syncAccounts(buildAccountChangeSubscriptionRequest({
  account: { account_id: accountId },
  currentConfigs, // Complete current array from this account's listAccounts read.
  subscriber: {
    subscriber_id: 'buyer-primary',
    url: receiverUrl,
    active: true,
  },
}));
// Check result.success AND each result.data.accounts[].action/errors and readback.
```

`currentConfigs` is required: pass `[]` only when the current set is known to be
empty. The builder produces a settings-only account update, merges by
`subscriber_id`, retains other subscribers and adds `account.change_recorded`
without dropping that subscriber's other event selections. It rejects duplicate
subscriber IDs and rejects endpoint changes for an existing subscriber
(`field: subscriber.url`), because readback may hide credentials. Rotate
endpoints through the seller's authenticated subscription management flow. Set `active: true` explicitly to reactivate an
inactive subscription. This builder adds event selections; remove unwanted selections
from the current subscriber entry before building, or use the raw settings API
for removal. It does not provision accounts or set `delete_missing`.

The wire update replaces the account's subscriber set. Serialize the
read/modify/write operation with other writers in your runtime; this builder
cannot make an external read and write atomic. Readback omits legacy credentials;
do not reconstruct missing secrets from webhook data. The seller's existing
subscription runtime owns credential preservation, endpoint proof, authorization
and fanout. This helper does not implement issue #2848's runtime.

## Drain and bootstrap

```typescript
import {
  streamAccountChanges,
  restoreAccountChangeCursor,
  AccountChangeCursorExpiredError,
} from '@adcp/sdk';

const saved = await checkpoints.load(partition);
for await (const page of streamAccountChanges(agent, {
  account: { account_id: accountId },
  cursor: saved === undefined ? undefined : restoreAccountChangeCursor(saved),
  resourceTypes: ['creative'],
  maxResults: 100,
  bootstrap: async ({ reason }) => {
    // Enumerate ALL statuses and pages from the authoritative reads in scope.
    // Replace the projection, including removing resources no longer visible.
    // The SDK has already acquired a fresh latest checkpoint (C0).
    await rebuildCreativeProjection(reason);
  },
})) {
  // Construct locally validated read requests from trusted account identity
  // and each change.resource; do not dispatch arbitrary repair.task arguments.
  const repaired = await readCurrentCreativeState(page.changes);
  await page.acknowledge(async cursor => {
    await database.transaction(async tx => {
      await applyRepairs(tx, repaired);
      await checkpoints.save(tx, partition, cursor.value);
    });
  });
}
```

`partition` must identify the seller, authenticated principal, resolved account
and normalized resource filter set. The guarded API requires an `account_id`;
resolve natural account references with `listAccounts()` first. Keep it fixed across continuation calls.
The stream sorts and deduplicates resource filters. Omit `resourceTypes` for an
unfiltered feed; an empty array or `maxResults` outside 1–100 is a
`ConfigurationError`. Changing a filter or account requires a separate checkpoint/bootstrap; reusing
an old cursor under a changed filter can skip history and the seller rejects it.
Do not infer shared access from equal buyer-visible account IDs.

With a `bootstrap` hook and no stored cursor, the SDK acquires `latest`, invokes
the hook, then drains **after C0**. C0 is not exposed as an acknowledged
checkpoint. Changes that arrived during the snapshot read are processed before
installation of a page checkpoint. Without a bootstrap hook or saved cursor,
the stream explicitly starts at `earliest` (oldest retained history).

Every page, including an empty filtered page or an empty tail, must be
acknowledged. Only `acknowledge()` supplies a `DurableAccountChangeCursor` to the
commit hook. A failed hook does not advance the stream; you may retry that
page's acknowledgement if your transaction semantics permit it. Asking for
another page before acknowledgement fails with
`account_change_checkpoint_unacknowledged`. Abandoning/closing a stream revokes
its pending page. Concurrent acknowledgements are rejected. Await the commit
before advancing or closing the iterator; the SDK cannot cancel an external
transaction already in progress.

The stream stops at `has_more: false`. Invoke it again after notifications and
poll periodically to recover from lost webhooks. Preserve returned order;
`recorded_at`, `occurred_at`, `batch_id` and opaque cursor strings are not sort
keys. `source_coverage` passes through on each page: reaching seller ingestion
tail does not imply that an unavailable or delayed connected source is current.

## Expiry and errors

On structured `CURSOR_EXPIRED`, an installed `bootstrap` hook triggers this
sequence: new `latest` checkpoint → authoritative snapshot rebuild → drain →
acknowledge. Rebuild can remove data no longer authorized. The helper reboots
at most once per invocation; repeated expiry is surfaced instead of looping.
If rebuilding fails, no replacement checkpoint is offered. Other failures,
including `INVALID_REQUEST` for filter/account mismatch, never silently restart. Correct the scope or seller error before retrying. If
you deliberately abandon a checkpoint, rebuild all snapshots with a new
`latest` position; never skip an incompatible page.

Without a bootstrap hook, or on repeated expiry, catch
`AccountChangeCursorExpiredError` (`code: 'CURSOR_EXPIRED'`,
`recovery: 'correctable'`). Its `result` preserves the original `TaskResult`,
including the structured reason. The raw `listAccountChanges()` escape hatch
continues returning `TaskResult<ListAccountChangesResponse>` for callers that
own their own bootstrap state machine.

`AccountChangeDrainError.code` distinguishes `account_change_read_failed`,
`account_change_page_invalid`, `account_change_checkpoint_unacknowledged`,
`account_change_checkpoint_closed` and
`account_change_checkpoint_commit_in_progress`. Read errors retain `result`.
`AccountChangeCursorError` (`account_change_cursor_invalid`) identifies invalid
stored cursor bytes or an advisory cursor supplied to the guarded stream. A
missing bundled schema throws `ConfigurationError`, distinct from seller data
errors. Hook exceptions propagate unchanged. Public type aliases `AccountChangePage`,
`AccountChangeFailure` and `AccountChangeSourceCoverage` derive from the existing
wire types.

## Receive notifications

Authenticate the original request bytes with the SDK's RFC 9421 webhook verifier
before parsing. Select the account and subscriber from the authenticated local
subscription, not from an unauthenticated payload.

```typescript
import { parseAccountChangeNotification } from '@adcp/sdk/webhooks';

const notice = parseAccountChangeNotification(verifiedBody, {
  accountId,
  subscriberId: 'buyer-primary',
  // previous: prior fire loaded by sender/account/subscriber/retry or logical ID
  // change: corresponding authoritative feed record, when already available
});
await scheduleDrain(partition);
```

The parser accepts JSON strings, UTF-8 bytes or parsed objects and validates the
published schema. The default body limit is 64 KiB, adjustable via the third
argument `{ maxBytes }`; cyclic, non-JSON and excessively nested objects are
rejected before cloning. Feed records remain limited to the protocol's 64 KiB.
It checks `notification_id === change_id`, the expected
account/subscriber and any nested account identity. When a matching record or
prior notification is supplied, it also checks resource type/ID/parents, action,
recorded time and logical identity. The same retry key requires the same fire
time and advisory target. A deliberate re-emission can use a new retry key and
fire time while keeping the logical change identity.

Deduplicate delivery retries by authenticated sender, account, subscriber and
`idempotencyKey`; correlate logical changes using `changeId` in that same scope.
The parser does not store deduplication state. Unknown resource types and action
names remain generic invalidations; choose an authoritative snapshot repair or
an explicit unsupported-coverage policy instead of silently discarding them.
Treat resource IDs, parent IDs, summaries, reasons, actor labels, paths and
extensions as untrusted data: never interpolate them into system instructions,
execute them or use them as authorization evidence. Raw error `result` values
are also untrusted diagnostics.

Malformed deliveries throw `AccountChangeNotificationError`, whose `code` is
`account_change_body_malformed`, `account_change_schema_invalid` or
`account_change_identity_mismatch`, with a `field` and no reflected payload.

`throughCursor` is a branded `AdvisoryThroughCursor` object. It cannot be assigned
to a `DurableAccountChangeCursor`, a raw wire cursor or `restoreAccountChangeCursor`.
Its `value` is available for diagnostics; **never promote it through the restore
function**. Drain from your own stored cursor to ingestion tail. No comparison
of two opaque tokens can prove that intervening pages have been processed.

## Ownership and integration

The SDK owns parsing, wire validation, typed calls and the acknowledgement order.
Your application owns crash recovery, durable checkpoint storage, projection
transactions, worker fencing and snapshot staging/replacement. A failed rebuild
must leave enough durable state to restart bootstrap; the helper makes no
exactly-once or transaction guarantee. Seller retention and the durable feed
store remain issue #2681's responsibility. Neither #2681 nor #2848 is a new
dependency of these primitives.

The packed regression connects an official MCP client to the packed SDK server
and checks the exact `tools/list` input schema: `list_account_changes` has a
plain object root without `oneOf`, `anyOf` or `allOf`. The mutually exclusive
`cursor`/`starting_position` rule is still enforced before the handler, even
with schema validation disabled.

The integration test uses the published `media_buy_seller/account_change_feed`
storyboard from the SDK's pinned compliance bundle and the actual upstream
training seller introduced by [adcp#6811](https://github.com/adcontextprotocol/adcp/pull/6811).
Run it against a local/test training deployment with account-change capability
enabled; hosted production intentionally disables this process-local feed until
it has durable storage. See the test's environment options for endpoint and
webhook receiver configuration.

For a reproducible integration (Docker with Node 22), use the [companion training
seller fix](https://github.com/adcontextprotocol/adcp/pull/7516). Install that checkout's dependencies and run the
SDK's launcher, which mounts the upstream router and its session persistence:

```bash
git clone https://github.com/adcontextprotocol/adcp.git .context/account-feed/upstream
git -C .context/account-feed/upstream fetch origin pull/7516/head
git -C .context/account-feed/upstream checkout FETCH_HEAD
npm --prefix .context/account-feed/upstream ci --ignore-scripts
docker run --rm --network host \
  -v "$PWD:$PWD" -w "$PWD" node:22-bookworm-slim \
  node --import "$PWD/.context/account-feed/upstream/node_modules/tsx/dist/loader.mjs" \
  test/helpers/account-feed-training-server.mjs
```

In a second terminal after `npm run build:lib`, use the endpoint and supported
wire version printed by the launcher:

```bash
ADCP_ACCOUNT_FEED_TRAINING_URL=http://127.0.0.1:4787/api/training-agent/sales/mcp \
ADCP_ACCOUNT_FEED_TRAINING_TOKEN=account-feed-local-test-token \
ADCP_ACCOUNT_FEED_WIRE_VERSION=3.2-rc.1 \
node --test test/e2e/account-change-feed-training.test.js
```

The training seller's supported wire checkpoint can lag its repository's
published schema version. The test validates against the SDK's pinned published
schema and storyboard bundle; the wire override selects a release that the
seller actually serves. The rc.2 and rc.3 account-feed storyboard is identical.

The runner understands the published flat account-change webhook selectors and
requires distinct logical changes for successive observations on the registered
subscriber URL, after the triggering request began. The test materializes named
fixture UUIDs once across phases; all published response assertions remain
enabled. The launcher contains no seller handlers or replacement response data.

The companion fix updates the shared creative snapshot before exposing its
status-change record and webhook, so the subsequent authoritative
`list_creatives` repair sees the recorded status. It also declares the existing
creative library needed by the scenario's applicability check. Those training
seller changes belong upstream; they do not introduce buyer durable storage or
a persistent subscription runtime into the SDK.
