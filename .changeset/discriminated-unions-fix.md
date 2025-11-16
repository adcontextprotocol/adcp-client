---
"@adcp/client": minor
---

Add discriminated union support and fix missing AdCP tools

- Re-synced AdCP schemas to include all 13 tools (was only generating 4)
- Added support for discriminated unions in type definitions:
  - publisher_properties: selection_type ('by_id' | 'by_tag')
  - assets_required: item_type ('individual' | 'repeatable_group')
  - PreviewCreativeRequest: request_type ('single' | 'batch')
  - VAST/DAAST assets: delivery_type ('url' | 'inline')
- Fixed preview-utils.ts to include required request_type field

All 13 AdCP tools now properly generated: get_products, list_creative_formats, create_media_buy, sync_creatives, list_creatives, update_media_buy, get_media_buy_delivery, list_authorized_properties, provide_performance_feedback, build_creative, preview_creative, get_signals, activate_signal
