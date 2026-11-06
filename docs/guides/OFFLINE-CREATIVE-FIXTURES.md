# Offline legacy creative fixtures

A media-buy seller accepting inline creatives does not need to expose
`list_creative_formats` or `sync_creatives`. To build legacy manifests from the
declaring agent's exact slot IDs, supply declarations you obtained from that
agent in the operator's test-kit override:

```yaml
creative_formats:
  - format_id:
      agent_url: https://creative.example/formats
      id: display_custom
      width: 300
      height: 250
    name: Acme display
    assets:
      - item_type: individual
        asset_id: banner_image
        asset_type: image
        required: true
      - item_type: individual
        asset_id: landing_page
        asset_type: url
        required: true
```

Keep the usual `assets.images`, `assets.click_url`, and other fixture ingredients
in the same kit. These declarations are operator inputs: the runner does not
fetch their URLs, forward credentials, seed formats, replace captured discovery
data, or call the seller's Creative Protocol tools.

The storyboard must declare `requires: [test_kit_format_catalog_runner]` and use:

```yaml
assets:
  $build_assets_from_format:
    format_id: "$context.legacy_format_id"
    catalog: test_kit
```

Only this exact wrapper selects the offline catalog. The existing direct-format
and context-catalog forms retain their behavior. Older runners treat the new
requirement as unmet before fixture mutation.

Matching uses the entire reference after standard agent-URL canonicalization,
including variant parameters and extension fields. A template is not an exact
match for a parameterized reference. Supply an explicit `assets` array; an empty
array declares no required slots, while a missing array is malformed. Invalid
declarations, duplicate slot IDs, duplicate exact references, and malformed
captured references are authoring errors. Missing catalogs or exact references
are `fixture_unavailable`, as are unsupported required slots or constraints.
The current fixture builder conservatively declines duration, density other
than 1, and extension parameters even when the catalog contains an exact match.
It also declines required accessibility metadata, nonempty delivery contracts,
multiple or ranged renders, unsupported nested dimension constraints, and
templates missing the logical dimensions required by their slots. Legacy
`assets` remains the slot authority; canonical/helper extension fields cannot
override it or the captured reference's dimensions. Size-looking IDs do not
supply missing dimensions.

Preflight checks every remaining manifest in an eligible phase before its first
mutation. Put legacy discovery and the whole legacy execution phase before any
canonical purchases when a later legacy fixture gap must prevent all buys. A
context-gated future phase is not eligible until its gate is evaluated. A missing
legacy representation closes its gate, so canonical-only catalogs need no legacy
preparation. A seller refusing a valid prepared manifest remains a test failure.
