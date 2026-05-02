// Generated entity-hydration field map — do NOT edit by hand
//
// Source: `schemas/cache/3.0.4/manifest.json` + per-tool request
// schemas. Every top-level `x-entity`-tagged string field on a request
// schema lands here. The runtime hydrator (`from-platform.ts` →
// `hydrateForTool`) walks this map plus the hand-curated
// `ENTITY_TO_RESOURCE_KIND` table to drive auto-hydration without
// re-walking schemas at startup.
//
// Renaming-firewall: if the spec renames `media_buy_id` → `mediabuy_id`,
// the `x-entity` tag travels with it; the next codegen run picks up
// the new field name automatically.
//
// Regenerate with: npm run generate-entity-hydration

export interface EntityHydrationField {
  /** Top-level property on the wire request object. */
  readonly field: string;
  /** Spec `x-entity` annotation — maps to `ResourceKind` at runtime. */
  readonly xEntity: string;
}

export const TOOL_ENTITY_FIELDS: Readonly<Record<string, ReadonlyArray<EntityHydrationField>>> = {
  acquire_rights: [
    { field: "pricing_option_id", xEntity: "vendor_pricing_option" },
    { field: "rights_id", xEntity: "rights_grant" },
  ],
  activate_signal: [
    { field: "pricing_option_id", xEntity: "vendor_pricing_option" },
    { field: "signal_agent_segment_id", xEntity: "signal_activation_id" },
  ],
  build_creative: [
    { field: "creative_id", xEntity: "creative" },
    { field: "media_buy_id", xEntity: "media_buy" },
    { field: "package_id", xEntity: "package" },
  ],
  check_governance: [
    { field: "plan_id", xEntity: "governance_plan" },
  ],
  create_media_buy: [
    { field: "plan_id", xEntity: "governance_plan" },
  ],
  delete_collection_list: [
    { field: "list_id", xEntity: "collection_list" },
  ],
  delete_property_list: [
    { field: "list_id", xEntity: "property_list" },
  ],
  get_brand_identity: [
    { field: "brand_id", xEntity: "advertiser_brand" },
  ],
  get_collection_list: [
    { field: "list_id", xEntity: "collection_list" },
  ],
  get_property_list: [
    { field: "list_id", xEntity: "property_list" },
  ],
  get_rights: [
    { field: "brand_id", xEntity: "rights_holder_brand" },
  ],
  log_event: [
    { field: "event_source_id", xEntity: "event_source" },
  ],
  preview_creative: [
    { field: "creative_id", xEntity: "creative" },
  ],
  provide_performance_feedback: [
    { field: "creative_id", xEntity: "creative" },
    { field: "media_buy_id", xEntity: "media_buy" },
    { field: "package_id", xEntity: "package" },
  ],
  report_plan_outcome: [
    { field: "check_id", xEntity: "governance_check" },
    { field: "plan_id", xEntity: "governance_plan" },
  ],
  si_get_offering: [
    { field: "offering_id", xEntity: "offering" },
  ],
  si_initiate_session: [
    { field: "media_buy_id", xEntity: "media_buy" },
    { field: "offering_id", xEntity: "offering" },
  ],
  si_send_message: [
    { field: "session_id", xEntity: "si_session" },
  ],
  si_terminate_session: [
    { field: "session_id", xEntity: "si_session" },
  ],
  update_collection_list: [
    { field: "list_id", xEntity: "collection_list" },
  ],
  update_media_buy: [
    { field: "media_buy_id", xEntity: "media_buy" },
  ],
  update_property_list: [
    { field: "list_id", xEntity: "property_list" },
  ],
  update_rights: [
    { field: "pricing_option_id", xEntity: "vendor_pricing_option" },
    { field: "rights_id", xEntity: "rights_grant" },
  ],
  validate_property_delivery: [
    { field: "list_id", xEntity: "property_list" },
  ],
};
