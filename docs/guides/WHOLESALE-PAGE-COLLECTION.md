# Collecting a wholesale product feed in a storyboard

Set `collect_product_pages: true` on a `get_products` wholesale step when its
checks need products beyond the seller's first page. Ordinary steps continue to
make one request. Declare the intrinsic runtime requirement so an older runner
reports missing coverage before fixture setup instead of ignoring the new flag:

```yaml
requires: [collect_product_pages_runner]
phases:
  - id: discovery
    steps:
      - id: complete_catalog
        task: get_products
        collect_product_pages: true
        sample_request:
          buying_mode: wholesale
          pagination: { max_results: 25 }
          account: { account_id: seller-issued-account }
        validations:
          - check: field_contains
            path: products[*].product_id
            value: expected-product
```

The first request is unconditional and must omit a continuation cursor. The
runner preserves account, filters, fields, context, idempotency key, extensions,
and the authored page size on each continuation. It follows every cursor,
validates every response, rejects duplicate identities and broken cursors, and
restarts when the feed identity changes. It permits at most three restarts,
1,000 physical requests, and 100,000 products. Exhausting a budget fails the
logical read and never publishes a successful partial snapshot.

Authored field checks and context captures use
`product_page_collection.logical_response`. The ordinary `response` and
`response_record` retain an actual physical page; they never masquerade as a
merged seller response. Each page has its own request, response, extraction,
schema disposition, and restart number under `product_page_collection.pages`.
Logical-check pointers are prefixed with
`/product_page_collection/logical_response`. Physical schema and invariant
failures cite the actual page exchange instead.

Every physical page runs the step's enabled invariants before response-evidence
retention limits apply, including pages later abandoned during a restart. The
report retains the first 16 page responses and every request. Later responses
carry an explicit retention marker; failing checks still retain their actual
page evidence. Unknown or custom pricing remains visibly unproven under its
existing invariant contract.

Expected-error probes, raw authentication probes, parallel dispatch, conditional
feed reads, and response-derived skip gates cannot be combined with collection.
Credentialed functional steps through the official protocol client remain
supported. `runStoryboardStep` exposes the same complete view and page checks.
