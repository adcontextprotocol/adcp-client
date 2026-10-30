# Parsing media-buy delivery webhooks

Use `parseMediaBuyDeliveryWebhook` from `@adcp/sdk/webhooks` after your receiver
has authenticated the original HTTP body and enforced replay protection. It
validates delivery content without requiring an `AgentClient`, an SDK callback
registry, or a signature-verification strategy. It performs no authentication
itself; `ok: true` means the payload is valid, not that its sender is trusted.

```typescript
import { parseMediaBuyDeliveryWebhook } from '@adcp/sdk/webhooks';

// Call only after signature verification. Load the version from the registered
// seller/buy record, rather than trusting a version claim in the request body.
function parseAuthenticatedDelivery(verifiedRawBody: Uint8Array, negotiatedVersion: string) {
  const parsed = parseMediaBuyDeliveryWebhook(verifiedRawBody, {
    adcpVersion: negotiatedVersion,
  });
  if (!parsed.ok) {
    // Suitable for a 400 response: paths are readable and omit report values (map key names can appear in paths).
    // e.g. result.media_buy_deliveries[0].by_package is required
    return { status: 400, error: parsed.message, errors: parsed.errors };
  }
  return { status: 200, report: parsed.result };
}
```

Pass the exact bytes you authenticated to avoid parsing a different body from
JSON middleware. The parser also accepts a parsed JSON object or a JSON string. It returns
a detached copy of validated data and preserves the seller's fields. It does
not add a task status, operation ID, currency, package breakdown, or other
missing data. Bodies are limited to 16 MiB and 64 nesting levels before schema
validation. Schema diagnostics use fail-fast validation and readable paths.
Invalid bodies return one of:

| Code | Meaning |
| --- | --- |
| `webhook_envelope_invalid` | Malformed JSON, invalid envelope metadata, or a missing result. |
| `webhook_result_invalid` | The nested delivery report fails the selected release's schema. |
| `webhook_unsupported_payload` | Another task type, or an unenveloped report without explicit opt-in. |

An invalid or unbundled `adcpVersion` is a caller configuration error and throws
`ConfigurationError`. Omission selects the SDK's protocol pin. The body does not
select its own validation release.

## Select the release used for the buy

A reporting webhook does not provide a trustworthy negotiated-version field.
Keep that release with the callback/buy registration and supply it for every
report. Stable patch pins select their bundled minor contract; preview pins
remain exact.

| Release | Report validation | Envelope details |
| --- | --- | --- |
| 3.0 | `get-media-buy-delivery-response.json`; report-wide currency is required. | `operation_id` is optional and remains absent when omitted. The parser accepts the documented `media_buy_delivery` discriminator even though the old task enum omits it. |
| 3.1 | `media-buy-delivery-webhook-result.json`; report-wide currency is required. | `operation_id` is required. |
| 3.2 | Dedicated webhook-result schema; report-wide currency is optional. | `operation_id` is required. |
| 3.3 beta | Exact bundled beta webhook-result schema; report-wide currency is optional. | `operation_id` is required. |

All releases require `by_package` on each delivery row. The SDK's schema loader
handles both relative and absolute schema IDs. No external `$ref` traversal or
network fetch is needed.

The registered reporting-delivery branch of `verifyAndParseWebhook` uses this
same parser after authentication. Its new `adcpVersion` request option selects
the stored seller/buy release; omission retains the client's configured pin.
This option changes payload validation only, not signature policy or trusted
sender/route selection. Schema configuration is prepared before nonce consumption;
invalid receiver configuration returns `webhook_verification_unavailable`.
Routing `metadata.operationId` always comes from the trusted registration;
the seller's original `operation_id` remains in the envelope. Existing legacy task-webhook normalization remains a
separate compatibility path.

## Bare-report compatibility is explicit

The default rejects a body with top-level `media_buy_deliveries` and no MCP
envelope. For a temporary migration, opt in explicitly:

```typescript
const parsed = parseMediaBuyDeliveryWebhook(verifiedRawBody, {
  adcpVersion: savedBuy.adcpVersion,
  acceptBareDeliveryReport: true,
});
if (parsed.ok && parsed.wireFormat === 'bare_delivery_report') {
  // Record the seller's protocol violation and repair its callback format.
  // parsed.envelope is undefined; no transport identity has been invented.
}
```

The report still undergoes release-specific validation. A poll-shaped report
with only a task `status` and no envelope identity is also bare; any such field
is preserved when the selected report schema permits it. An incomplete or invalid
envelope never falls back to bare-report acceptance. A normal envelope returns
`wireFormat: 'mcp_envelope'` and the validated `envelope`. Authentication and
sender, account, media-buy authorization, and deduplication remain the receiver's
responsibility in either format.

## A shared delivery body for polling and pushing

`MediaBuyDeliveryReport` imports from `@adcp/sdk/types` or `@adcp/sdk/webhooks`.
`MediaBuyDeliveryReportSchema` imports from `@adcp/sdk/schemas` and
`@adcp/sdk/schemas/browser`. This payload-only shape accepts a polled report or a
webhook result without requiring a task-level `status`. The shared TypeScript type and these Zod schemas describe
the SDK's current pin; use the parser above for older release-specific checks.

`GetMediaBuyDeliveryResponseSchema` still requires task status through its
referenced `core/protocol-envelope.json`. The absence of `status` from the
response document's own `required` list does not remove that inherited
requirement. Use the shared body schema for ingestion, and the full response
schema for a poll's protocol envelope. `MediaBuyDeliveryWebhookResultSchema`
now retains the canonical required row fields, including `by_package`.

## Envelope status and notification type are independent

The parser accepts the selected release's task-status enum; it does not require
`completed` for all reporting messages. For example, `notification_type:
'delayed'` may accompany `status: 'working'` when a valid report is present.
`delayed` itself is not a task status. A progress-only message without a report
is not a delivery-data webhook.

`notification_type: 'final'` concerns report scheduling; envelope `completed`
does not mean the media buy has finished. Per-buy state remains in
`media_buy_deliveries[].status`. This follows the protocol's
[envelope/result distinction](https://github.com/adcontextprotocol/adcp/blob/v3.3.0-beta.2/docs/building/by-layer/L3/webhooks.mdx#payload-anatomy-envelope-vs-result).

The protocol also requires receivers to ignore `aggregated_totals` in pushed
reports as an authority source. The parser preserves that field for auditing
when supplied; reconcile authoritative totals through a poll or per-delivery
rows instead.

For offline tooling that needs all raw JSON Schema diagnostics,
`@adcp/sdk/schemas` also exports `getSchemaValidatorByRef`. Its default is
fail-fast; complete diagnostics are an explicit option:

```typescript
import { getSchemaValidatorByRef } from '@adcp/sdk/schemas';
const validate = getSchemaValidatorByRef(
  'media-buy/media-buy-delivery-webhook-result.json',
  '3.1',
  undefined,
  { allErrors: true },
);
```
