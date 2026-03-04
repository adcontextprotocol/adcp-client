---
"@adcp/client": minor
---

Add v3 protocol testing scenarios: property_list_filters, si_handoff, schema_compliance

- `property_list_filters`: Tests all 4 property list filter types (garm_categories, mfa_thresholds, custom_tags, feature_requirements) with round-trip validation via get_property_list resolve:true
- `si_handoff`: Tests ACP handoff flow — initiates session, sends purchase-intent message, terminates with `reason: 'handoff_transaction'`, validates acp_handoff structure
- `schema_compliance`: GET-only validation of v3 field correctness: channel enum values (hard fail on invalid), pricing field names (fixed_price, floor_price placement), format assets structure
- Adds UI element schema validation to `si_session_lifecycle`: validates all 8 element types (text, link, image, product_card, carousel, action_button, app_handoff, integration_actions) and type-specific required fields
- Fixes `si_terminate_session` using invalid `reason: 'user_ended'` — corrected to `'user_exit'`
