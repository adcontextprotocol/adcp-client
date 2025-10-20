// Generated Zod schemas from official AdCP schemas v2.1.0
// Generated at: 2025-10-20T09:03:13.772Z
// These schemas provide runtime validation for AdCP data structures

import { z } from 'zod';

// MEDIA-BUY SCHEMA
export const MediaBuySchema = z.object({ "media_buy_id": z.string().describe("Publisher's unique identifier for the media buy"), "buyer_ref": z.string().describe("Buyer's reference identifier for this media buy").optional(), "status": z.any(), "promoted_offering": z.string().describe("Description of advertiser and what is being promoted"), "total_budget": z.number().gte(0).describe("Total budget amount"), "packages": z.array(z.any()).describe("Array of packages within this media buy"), "creative_deadline": z.string().datetime({ offset: true }).describe("ISO 8601 timestamp for creative upload deadline").optional(), "created_at": z.string().datetime({ offset: true }).describe("Creation timestamp").optional(), "updated_at": z.string().datetime({ offset: true }).describe("Last update timestamp").optional() }).strict().describe("Represents a purchased advertising campaign")


// CREATIVE-ASSET SCHEMA
export const CreativeAssetSchema = z.object({ "creative_id": z.string().describe("Unique identifier for the creative"), "name": z.string().describe("Human-readable creative name"), "format_id": z.any().describe("Format identifier specifying which format this creative conforms to"), "assets": z.record(z.union([z.any().superRefine((x, ctx) => {
    const schemas = [z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any()];
    const errors = schemas.reduce<z.ZodError[]>(
      (errors, schema) =>
        ((result) =>
          result.error ? [...errors, result.error] : errors)(
          schema.safeParse(x),
        ),
      [],
    );
    if (schemas.length - errors.length !== 1) {
      ctx.addIssue({
        path: ctx.path,
        code: "invalid_union",
        unionErrors: errors,
        message: "Invalid input: Should pass single schema",
      });
    }
  }), z.never()])).superRefine((value, ctx) => {
for (const key in value) {
let evaluated = false
if (key.match(new RegExp("^[a-zA-Z0-9_-]+$"))) {
evaluated = true
const result = z.any().superRefine((x, ctx) => {
    const schemas = [z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any()];
    const errors = schemas.reduce<z.ZodError[]>(
      (errors, schema) =>
        ((result) =>
          result.error ? [...errors, result.error] : errors)(
          schema.safeParse(x),
        ),
      [],
    );
    if (schemas.length - errors.length !== 1) {
      ctx.addIssue({
        path: ctx.path,
        code: "invalid_union",
        unionErrors: errors,
        message: "Invalid input: Should pass single schema",
      });
    }
  }).safeParse(value[key])
if (!result.success) {
ctx.addIssue({
          path: [...ctx.path, key],
          code: 'custom',
          message: `Invalid input: Key matching regex /${key}/ must match schema`,
          params: {
            issues: result.error.issues
          }
        })
}
}
if (!evaluated) {
const result = z.never().safeParse(value[key])
if (!result.success) {
ctx.addIssue({
          path: [...ctx.path, key],
          code: 'custom',
          message: `Invalid input: must match catchall schema`,
          params: {
            issues: result.error.issues
          }
        })
}
}
}
}).describe("Assets required by the format, keyed by asset_role"), "inputs": z.array(z.object({ "name": z.string().describe("Human-readable name for this preview variant"), "macros": z.record(z.string()).describe("Macro values to apply for this preview").optional(), "context_description": z.string().describe("Natural language description of the context for AI-generated content").optional() }).strict()).describe("Preview contexts for generative formats - defines what scenarios to generate previews for").optional(), "tags": z.array(z.string()).describe("User-defined tags for organization and searchability").optional(), "approved": z.boolean().describe("For generative creatives: set to true to approve and finalize, false to request regeneration with updated assets/message. Omit for non-generative creatives.").optional() }).strict().describe("Creative asset for upload to library - supports static assets, generative formats, and third-party snippets")


// PRODUCT SCHEMA
export const ProductSchema = z.object({ "product_id": z.string().describe("Unique identifier for the product"), "name": z.string().describe("Human-readable product name"), "description": z.string().describe("Detailed description of the product and its inventory"), "properties": z.array(z.any()).min(1).describe("Array of advertising properties covered by this product for adagents.json validation").optional(), "property_tags": z.array(z.string().regex(new RegExp("^[a-z0-9_]+$")).describe("Lowercase tag with underscores (e.g., 'local_radio', 'premium_content')")).min(1).describe("Tags identifying groups of properties covered by this product (use list_authorized_properties to get full property details)").optional(), "format_ids": z.array(z.any()).describe("Array of supported creative format IDs - structured format_id objects with agent_url and id"), "delivery_type": z.any(), "pricing_options": z.array(z.any()).min(1).describe("Available pricing models for this product"), "estimated_exposures": z.number().int().gte(0).describe("Estimated exposures/impressions for guaranteed products").optional(), "measurement": z.any().optional(), "delivery_measurement": z.object({ "provider": z.string().describe("Measurement provider(s) used for this product (e.g., 'Google Ad Manager with IAS viewability', 'Nielsen DAR', 'Geopath for DOOH impressions')"), "notes": z.string().describe("Additional details about measurement methodology in plain language (e.g., 'MRC-accredited viewability. 50% in-view for 1s display / 2s video', 'Panel-based demographic measurement updated monthly')").optional() }).describe("Measurement provider and methodology for delivery metrics. The buyer accepts the declared provider as the source of truth for the buy. REQUIRED for all products."), "reporting_capabilities": z.any().optional(), "creative_policy": z.any().optional(), "is_custom": z.boolean().describe("Whether this is a custom product").optional(), "brief_relevance": z.string().describe("Explanation of why this product matches the brief (only included when brief is provided)").optional(), "expires_at": z.string().datetime({ offset: true }).describe("Expiration timestamp for custom products").optional() }).strict().and(z.any().superRefine((x, ctx) => {
    const schemas = [z.any(), z.any()];
    const errors = schemas.reduce<z.ZodError[]>(
      (errors, schema) =>
        ((result) =>
          result.error ? [...errors, result.error] : errors)(
          schema.safeParse(x),
        ),
      [],
    );
    if (schemas.length - errors.length !== 1) {
      ctx.addIssue({
        path: ctx.path,
        code: "invalid_union",
        unionErrors: errors,
        message: "Invalid input: Should pass single schema",
      });
    }
  })).describe("Represents available advertising inventory")


// TARGETING SCHEMA
export const TargetingSchema = z.object({ "geo_country_any_of": z.array(z.string().regex(new RegExp("^[A-Z]{2}$"))).describe("Restrict delivery to specific countries (ISO codes). Use for regulatory compliance or RCT testing.").optional(), "geo_region_any_of": z.array(z.string()).describe("Restrict delivery to specific regions/states. Use for regulatory compliance or RCT testing.").optional(), "geo_metro_any_of": z.array(z.string()).describe("Restrict delivery to specific metro areas (DMA codes). Use for regulatory compliance or RCT testing.").optional(), "geo_postal_code_any_of": z.array(z.string()).describe("Restrict delivery to specific postal/ZIP codes. Use for regulatory compliance or RCT testing.").optional(), "frequency_cap": z.any().optional() }).strict().describe("Optional geographic refinements for media buys. Most targeting should be expressed in the brief and handled by the publisher. These fields are primarily for geographic restrictions (RCT testing, regulatory compliance).")


// get_products request
export const GetProductsRequestSchema = z.object({ "brief": z.string().describe("Natural language description of campaign requirements").optional(), "brand_manifest": z.any().describe("Brand information manifest providing brand context, assets, and product catalog. Can be provided inline or as a URL reference to a hosted manifest."), "filters": z.object({ "delivery_type": z.any().optional(), "is_fixed_price": z.boolean().describe("Filter for fixed price vs auction products").optional(), "format_types": z.array(z.enum(["video","display","audio"])).describe("Filter by format types").optional(), "format_ids": z.array(z.any()).describe("Filter by specific format IDs").optional(), "standard_formats_only": z.boolean().describe("Only return products accepting IAB standard formats").optional(), "min_exposures": z.number().int().gte(1).describe("Minimum exposures/impressions needed for measurement validity").optional() }).strict().describe("Structured filters for product discovery").optional() }).strict().describe("Request parameters for discovering available advertising products")


// get_products response
export const GetProductsResponseSchema = z.object({ "products": z.array(z.any()).describe("Array of matching products"), "errors": z.array(z.any()).describe("Task-specific errors and warnings (e.g., product filtering issues)").optional() }).strict().describe("Response payload for get_products task")


// list_creative_formats request
export const ListCreativeFormatsRequestSchema = z.object({ "format_ids": z.array(z.any()).describe("Return only these specific format IDs (e.g., from get_products response)").optional(), "type": z.enum(["audio","video","display","dooh"]).describe("Filter by format type (technical categories with distinct requirements)").optional(), "asset_types": z.array(z.enum(["image","video","audio","text","html","javascript","url"])).describe("Filter to formats that include these asset types. For third-party tags, search for 'html' or 'javascript'. E.g., ['image', 'text'] returns formats with images and text, ['javascript'] returns formats accepting JavaScript tags.").optional(), "max_width": z.number().int().describe("Maximum width in pixels (inclusive). Returns formats where ANY render has width <= this value. For multi-render formats, matches if at least one render fits.").optional(), "max_height": z.number().int().describe("Maximum height in pixels (inclusive). Returns formats where ANY render has height <= this value. For multi-render formats, matches if at least one render fits.").optional(), "min_width": z.number().int().describe("Minimum width in pixels (inclusive). Returns formats where ANY render has width >= this value.").optional(), "min_height": z.number().int().describe("Minimum height in pixels (inclusive). Returns formats where ANY render has height >= this value.").optional(), "is_responsive": z.boolean().describe("Filter for responsive formats that adapt to container size. When true, returns formats without fixed dimensions.").optional(), "name_search": z.string().describe("Search for formats by name (case-insensitive partial match)").optional() }).strict().describe("Request parameters for discovering supported creative formats")


// list_creative_formats response
export const ListCreativeFormatsResponseSchema = z.object({ "formats": z.array(z.any()).describe("Full format definitions for all formats this agent supports. Each format's authoritative source is indicated by its agent_url field."), "creative_agents": z.array(z.object({ "agent_url": z.string().url().describe("Base URL for the creative agent (e.g., 'https://reference.adcp.org', 'https://dco.example.com'). Call list_creative_formats on this URL to get its formats."), "agent_name": z.string().describe("Human-readable name for the creative agent").optional(), "capabilities": z.array(z.enum(["validation","assembly","generation","preview"])).describe("Capabilities this creative agent provides").optional() })).describe("Optional: Creative agents that provide additional formats. Buyers can recursively query these agents to discover more formats. No authentication required for list_creative_formats.").optional(), "errors": z.array(z.any()).describe("Task-specific errors and warnings (e.g., format availability issues)").optional() }).strict().describe("Response payload for list_creative_formats task")


// create_media_buy request
export const CreateMediaBuyRequestSchema = z.object({ "buyer_ref": z.string().describe("Buyer's reference identifier for this media buy"), "packages": z.array(z.any()).describe("Array of package configurations"), "brand_manifest": z.any().describe("Brand information manifest serving as the namespace and identity for this media buy. Provides brand context, assets, and product catalog. Can be provided inline or as a URL reference to a hosted manifest. Can be cached and reused across multiple requests."), "po_number": z.string().describe("Purchase order number for tracking").optional(), "start_time": z.any(), "end_time": z.string().datetime({ offset: true }).describe("Campaign end date/time in ISO 8601 format"), "budget": z.number().gte(0).describe("Total budget for this media buy. Currency is determined by the pricing_option_id selected in each package."), "reporting_webhook": z.intersection(z.any(), z.object({ "reporting_frequency": z.enum(["hourly","daily","monthly"]).describe("Frequency for automated reporting delivery. Must be supported by all products in the media buy."), "requested_metrics": z.array(z.enum(["impressions","spend","clicks","ctr","video_completions","completion_rate","conversions","viewability","engagement_rate"])).describe("Optional list of metrics to include in webhook notifications. If omitted, all available metrics are included. Must be subset of product's available_metrics.").optional() }).describe("Optional webhook configuration for automated reporting delivery. Uses push_notification_config structure with additional reporting-specific fields.")).optional() }).strict().describe("Request parameters for creating a media buy")


// create_media_buy response
export const CreateMediaBuyResponseSchema = z.object({ "media_buy_id": z.string().describe("Publisher's unique identifier for the created media buy").optional(), "buyer_ref": z.string().describe("Buyer's reference identifier for this media buy"), "creative_deadline": z.string().datetime({ offset: true }).describe("ISO 8601 timestamp for creative upload deadline").optional(), "packages": z.array(z.object({ "package_id": z.string().describe("Publisher's unique identifier for the package"), "buyer_ref": z.string().describe("Buyer's reference identifier for the package") }).strict()).describe("Array of created packages").optional(), "errors": z.array(z.any()).describe("Task-specific errors and warnings (e.g., partial package creation failures)").optional() }).strict().describe("Response payload for create_media_buy task")


// sync_creatives request
export const SyncCreativesRequestSchema = z.object({ "creatives": z.array(z.any()).max(100).describe("Array of creative assets to sync (create or update)"), "patch": z.boolean().describe("When true, only provided fields are updated (partial update). When false, entire creative is replaced (full upsert).").default(false), "assignments": z.record(z.union([z.array(z.string()).describe("Array of package IDs to assign this creative to"), z.never()])).superRefine((value, ctx) => {
for (const key in value) {
let evaluated = false
if (key.match(new RegExp("^[a-zA-Z0-9_-]+$"))) {
evaluated = true
const result = z.array(z.string()).describe("Array of package IDs to assign this creative to").safeParse(value[key])
if (!result.success) {
ctx.addIssue({
          path: [...ctx.path, key],
          code: 'custom',
          message: `Invalid input: Key matching regex /${key}/ must match schema`,
          params: {
            issues: result.error.issues
          }
        })
}
}
if (!evaluated) {
const result = z.never().safeParse(value[key])
if (!result.success) {
ctx.addIssue({
          path: [...ctx.path, key],
          code: 'custom',
          message: `Invalid input: must match catchall schema`,
          params: {
            issues: result.error.issues
          }
        })
}
}
}
}).describe("Optional bulk assignment of creatives to packages").optional(), "delete_missing": z.boolean().describe("When true, creatives not included in this sync will be archived. Use with caution for full library replacement.").default(false), "dry_run": z.boolean().describe("When true, preview changes without applying them. Returns what would be created/updated/deleted.").default(false), "validation_mode": z.enum(["strict","lenient"]).describe("Validation strictness. 'strict' fails entire sync on any validation error. 'lenient' processes valid creatives and reports errors.").default("strict"), "push_notification_config": z.any().describe("Optional webhook configuration for async sync notifications. Publisher will send webhook when sync completes if operation takes longer than immediate response time (typically for large bulk operations or manual approval/HITL).").optional() }).strict().describe("Request parameters for syncing creative assets with upsert semantics - supports bulk operations, patch updates, and assignment management")


// sync_creatives response
export const SyncCreativesResponseSchema = z.object({ "dry_run": z.boolean().describe("Whether this was a dry run (no actual changes made)").optional(), "creatives": z.array(z.object({ "creative_id": z.string().describe("Creative ID from the request"), "action": z.enum(["created","updated","unchanged","failed","deleted"]).describe("Action taken for this creative"), "platform_id": z.string().describe("Platform-specific ID assigned to the creative").optional(), "changes": z.array(z.string()).describe("Field names that were modified (only present when action='updated')").optional(), "errors": z.array(z.string()).describe("Validation or processing errors (only present when action='failed')").optional(), "warnings": z.array(z.string()).describe("Non-fatal warnings about this creative").optional(), "preview_url": z.string().url().describe("Preview URL for generative creatives (only present for generative formats)").optional(), "expires_at": z.string().datetime({ offset: true }).describe("ISO 8601 timestamp when preview link expires (only present when preview_url exists)").optional(), "assigned_to": z.array(z.string()).describe("Package IDs this creative was successfully assigned to (only present when assignments were requested)").optional(), "assignment_errors": z.record(z.union([z.string().describe("Error message for this package assignment"), z.never()])).superRefine((value, ctx) => {
for (const key in value) {
let evaluated = false
if (key.match(new RegExp("^[a-zA-Z0-9_-]+$"))) {
evaluated = true
const result = z.string().describe("Error message for this package assignment").safeParse(value[key])
if (!result.success) {
ctx.addIssue({
          path: [...ctx.path, key],
          code: 'custom',
          message: `Invalid input: Key matching regex /${key}/ must match schema`,
          params: {
            issues: result.error.issues
          }
        })
}
}
if (!evaluated) {
const result = z.never().safeParse(value[key])
if (!result.success) {
ctx.addIssue({
          path: [...ctx.path, key],
          code: 'custom',
          message: `Invalid input: must match catchall schema`,
          params: {
            issues: result.error.issues
          }
        })
}
}
}
}).describe("Assignment errors by package ID (only present when assignment failures occurred)").optional() }).strict()).describe("Results for each creative processed") }).strict().describe("Response from creative sync operation with results for each creative")


// list_creatives request
export const ListCreativesRequestSchema = z.object({ "filters": z.object({ "format": z.string().describe("Filter by creative format type (e.g., video, audio, display)").optional(), "formats": z.array(z.string()).describe("Filter by multiple creative format types").optional(), "status": z.any().describe("Filter by creative approval status").optional(), "statuses": z.array(z.any()).describe("Filter by multiple creative statuses").optional(), "tags": z.array(z.string()).describe("Filter by creative tags (all tags must match)").optional(), "tags_any": z.array(z.string()).describe("Filter by creative tags (any tag must match)").optional(), "name_contains": z.string().describe("Filter by creative names containing this text (case-insensitive)").optional(), "creative_ids": z.array(z.string()).max(100).describe("Filter by specific creative IDs").optional(), "created_after": z.string().datetime({ offset: true }).describe("Filter creatives created after this date (ISO 8601)").optional(), "created_before": z.string().datetime({ offset: true }).describe("Filter creatives created before this date (ISO 8601)").optional(), "updated_after": z.string().datetime({ offset: true }).describe("Filter creatives last updated after this date (ISO 8601)").optional(), "updated_before": z.string().datetime({ offset: true }).describe("Filter creatives last updated before this date (ISO 8601)").optional(), "assigned_to_package": z.string().describe("Filter creatives assigned to this specific package").optional(), "assigned_to_packages": z.array(z.string()).describe("Filter creatives assigned to any of these packages").optional(), "unassigned": z.boolean().describe("Filter for unassigned creatives when true, assigned creatives when false").optional(), "has_performance_data": z.boolean().describe("Filter creatives that have performance data when true").optional() }).strict().describe("Filter criteria for querying creatives").optional(), "sort": z.object({ "field": z.enum(["created_date","updated_date","name","status","assignment_count","performance_score"]).describe("Field to sort by").default("created_date"), "direction": z.enum(["asc","desc"]).describe("Sort direction").default("desc") }).strict().describe("Sorting parameters").optional(), "pagination": z.object({ "limit": z.number().int().gte(1).lte(100).describe("Maximum number of creatives to return").default(50), "offset": z.number().int().gte(0).describe("Number of creatives to skip").default(0) }).strict().describe("Pagination parameters").optional(), "include_assignments": z.boolean().describe("Include package assignment information in response").default(true), "include_performance": z.boolean().describe("Include aggregated performance metrics in response").default(false), "include_sub_assets": z.boolean().describe("Include sub-assets (for carousel/native formats) in response").default(false), "fields": z.array(z.enum(["creative_id","name","format","status","created_date","updated_date","tags","assignments","performance","sub_assets"])).describe("Specific fields to include in response (omit for all fields)").optional() }).strict().describe("Request parameters for querying creative assets from the centralized library with filtering, sorting, and pagination")


// list_creatives response
export const ListCreativesResponseSchema = z.object({ "query_summary": z.object({ "total_matching": z.number().int().gte(0).describe("Total number of creatives matching filters (across all pages)"), "returned": z.number().int().gte(0).describe("Number of creatives returned in this response"), "filters_applied": z.array(z.string()).describe("List of filters that were applied to the query").optional(), "sort_applied": z.object({ "field": z.string().optional(), "direction": z.enum(["asc","desc"]).optional() }).describe("Sort order that was applied").optional() }).strict().describe("Summary of the query that was executed"), "pagination": z.object({ "limit": z.number().int().gte(1).describe("Maximum number of results requested"), "offset": z.number().int().gte(0).describe("Number of results skipped"), "has_more": z.boolean().describe("Whether more results are available"), "total_pages": z.number().int().gte(0).describe("Total number of pages available").optional(), "current_page": z.number().int().gte(1).describe("Current page number (1-based)").optional() }).strict().describe("Pagination information for navigating results"), "creatives": z.array(z.object({ "creative_id": z.string().describe("Unique identifier for the creative"), "name": z.string().describe("Human-readable creative name"), "format_id": z.any().describe("Format identifier specifying which format this creative conforms to"), "status": z.any().describe("Current approval status of the creative"), "created_date": z.string().datetime({ offset: true }).describe("When the creative was uploaded to the library"), "updated_date": z.string().datetime({ offset: true }).describe("When the creative was last modified"), "media_url": z.string().url().describe("URL of the creative file (for hosted assets)").optional(), "assets": z.record(z.any().superRefine((x, ctx) => {
    const schemas = [z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any()];
    const errors = schemas.reduce<z.ZodError[]>(
      (errors, schema) =>
        ((result) =>
          result.error ? [...errors, result.error] : errors)(
          schema.safeParse(x),
        ),
      [],
    );
    if (schemas.length - errors.length !== 1) {
      ctx.addIssue({
        path: ctx.path,
        code: "invalid_union",
        unionErrors: errors,
        message: "Invalid input: Should pass single schema",
      });
    }
  })).superRefine((value, ctx) => {
for (const key in value) {
if (key.match(new RegExp("^[a-zA-Z0-9_-]+$"))) {
const result = z.any().superRefine((x, ctx) => {
    const schemas = [z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any(), z.any()];
    const errors = schemas.reduce<z.ZodError[]>(
      (errors, schema) =>
        ((result) =>
          result.error ? [...errors, result.error] : errors)(
          schema.safeParse(x),
        ),
      [],
    );
    if (schemas.length - errors.length !== 1) {
      ctx.addIssue({
        path: ctx.path,
        code: "invalid_union",
        unionErrors: errors,
        message: "Invalid input: Should pass single schema",
      });
    }
  }).safeParse(value[key])
if (!result.success) {
ctx.addIssue({
          path: [...ctx.path, key],
          code: 'custom',
          message: `Invalid input: Key matching regex /${key}/ must match schema`,
          params: {
            issues: result.error.issues
          }
        })
}
}
}
}).describe("Assets for this creative, keyed by asset_role").optional(), "click_url": z.string().url().describe("Landing page URL for the creative").optional(), "duration": z.number().gte(0).describe("Duration in milliseconds (for video/audio)").optional(), "width": z.number().gte(0).describe("Width in pixels (for video/display)").optional(), "height": z.number().gte(0).describe("Height in pixels (for video/display)").optional(), "tags": z.array(z.string()).describe("User-defined tags for organization and searchability").optional(), "assignments": z.object({ "assignment_count": z.number().int().gte(0).describe("Total number of active package assignments"), "assigned_packages": z.array(z.object({ "package_id": z.string().describe("Package identifier"), "package_name": z.string().describe("Human-readable package name").optional(), "assigned_date": z.string().datetime({ offset: true }).describe("When this assignment was created"), "status": z.enum(["active","paused","ended"]).describe("Status of this specific assignment") }).strict()).describe("List of packages this creative is assigned to").optional() }).strict().describe("Current package assignments (included when include_assignments=true)").optional(), "performance": z.object({ "impressions": z.number().int().gte(0).describe("Total impressions across all assignments").optional(), "clicks": z.number().int().gte(0).describe("Total clicks across all assignments").optional(), "ctr": z.number().gte(0).lte(1).describe("Click-through rate (clicks/impressions)").optional(), "conversion_rate": z.number().gte(0).lte(1).describe("Conversion rate across all assignments").optional(), "performance_score": z.number().gte(0).lte(100).describe("Aggregated performance score (0-100)").optional(), "last_updated": z.string().datetime({ offset: true }).describe("When performance data was last updated") }).strict().describe("Aggregated performance metrics (included when include_performance=true)").optional(), "sub_assets": z.array(z.any()).describe("Sub-assets for multi-asset formats (included when include_sub_assets=true)").optional() }).strict()).describe("Array of creative assets matching the query"), "format_summary": z.record(z.union([z.number().int().gte(0).describe("Number of creatives with this format"), z.never()])).superRefine((value, ctx) => {
for (const key in value) {
let evaluated = false
if (key.match(new RegExp("^[a-zA-Z0-9_-]+$"))) {
evaluated = true
const result = z.number().int().gte(0).describe("Number of creatives with this format").safeParse(value[key])
if (!result.success) {
ctx.addIssue({
          path: [...ctx.path, key],
          code: 'custom',
          message: `Invalid input: Key matching regex /${key}/ must match schema`,
          params: {
            issues: result.error.issues
          }
        })
}
}
if (!evaluated) {
const result = z.never().safeParse(value[key])
if (!result.success) {
ctx.addIssue({
          path: [...ctx.path, key],
          code: 'custom',
          message: `Invalid input: must match catchall schema`,
          params: {
            issues: result.error.issues
          }
        })
}
}
}
}).describe("Breakdown of creatives by format type").optional(), "status_summary": z.object({ "approved": z.number().int().gte(0).describe("Number of approved creatives").optional(), "pending_review": z.number().int().gte(0).describe("Number of creatives pending review").optional(), "rejected": z.number().int().gte(0).describe("Number of rejected creatives").optional(), "archived": z.number().int().gte(0).describe("Number of archived creatives").optional() }).strict().describe("Breakdown of creatives by status").optional() }).strict().describe("Response from creative library query with filtered results, metadata, and optional enriched data")


// update_media_buy request
export const UpdateMediaBuyRequestSchema = z.object({ "media_buy_id": z.string().describe("Publisher's ID of the media buy to update").optional(), "buyer_ref": z.string().describe("Buyer's reference for the media buy to update").optional(), "active": z.boolean().describe("Pause/resume the entire media buy").optional(), "start_time": z.any().optional(), "end_time": z.string().datetime({ offset: true }).describe("New end date/time in ISO 8601 format").optional(), "budget": z.number().gte(0).describe("Updated total budget for this media buy. Currency is determined by the pricing_option_id selected in each package.").optional(), "packages": z.array(z.object({ "package_id": z.string().describe("Publisher's ID of package to update").optional(), "buyer_ref": z.string().describe("Buyer's reference for the package to update").optional(), "budget": z.number().gte(0).describe("Updated budget allocation for this package in the currency specified by the pricing option").optional(), "active": z.boolean().describe("Pause/resume specific package").optional(), "targeting_overlay": z.any().optional(), "creative_ids": z.array(z.string()).describe("Update creative assignments").optional() }).strict().and(z.any().superRefine((x, ctx) => {
    const schemas = [z.any(), z.any()];
    const errors = schemas.reduce<z.ZodError[]>(
      (errors, schema) =>
        ((result) =>
          result.error ? [...errors, result.error] : errors)(
          schema.safeParse(x),
        ),
      [],
    );
    if (schemas.length - errors.length !== 1) {
      ctx.addIssue({
        path: ctx.path,
        code: "invalid_union",
        unionErrors: errors,
        message: "Invalid input: Should pass single schema",
      });
    }
  }))).describe("Package-specific updates").optional(), "push_notification_config": z.any().describe("Optional webhook configuration for async update notifications. Publisher will send webhook when update completes if operation takes longer than immediate response time.").optional() }).strict().and(z.any().superRefine((x, ctx) => {
    const schemas = [z.any(), z.any()];
    const errors = schemas.reduce<z.ZodError[]>(
      (errors, schema) =>
        ((result) =>
          result.error ? [...errors, result.error] : errors)(
          schema.safeParse(x),
        ),
      [],
    );
    if (schemas.length - errors.length !== 1) {
      ctx.addIssue({
        path: ctx.path,
        code: "invalid_union",
        unionErrors: errors,
        message: "Invalid input: Should pass single schema",
      });
    }
  })).describe("Request parameters for updating campaign and package settings")


// update_media_buy response
export const UpdateMediaBuyResponseSchema = z.object({ "media_buy_id": z.string().describe("Publisher's identifier for the media buy"), "buyer_ref": z.string().describe("Buyer's reference identifier for the media buy"), "implementation_date": z.union([z.string().datetime({ offset: true }).describe("ISO 8601 timestamp when changes take effect (null if pending approval)"), z.null().describe("ISO 8601 timestamp when changes take effect (null if pending approval)")]).describe("ISO 8601 timestamp when changes take effect (null if pending approval)").optional(), "affected_packages": z.array(z.object({ "package_id": z.string().describe("Publisher's package identifier"), "buyer_ref": z.string().describe("Buyer's reference for the package") }).strict()).describe("Array of packages that were modified").optional(), "errors": z.array(z.any()).describe("Task-specific errors and warnings (e.g., partial update failures)").optional() }).strict().describe("Response payload for update_media_buy task")


// get_media_buy_delivery request
export const GetMediaBuyDeliveryRequestSchema = z.object({ "media_buy_ids": z.array(z.string()).describe("Array of publisher media buy IDs to get delivery data for").optional(), "buyer_refs": z.array(z.string()).describe("Array of buyer reference IDs to get delivery data for").optional(), "status_filter": z.any().superRefine((x, ctx) => {
    const schemas = [z.enum(["active","pending","paused","completed","failed","all"]), z.array(z.enum(["active","pending","paused","completed","failed"]))];
    const errors = schemas.reduce<z.ZodError[]>(
      (errors, schema) =>
        ((result) =>
          result.error ? [...errors, result.error] : errors)(
          schema.safeParse(x),
        ),
      [],
    );
    if (schemas.length - errors.length !== 1) {
      ctx.addIssue({
        path: ctx.path,
        code: "invalid_union",
        unionErrors: errors,
        message: "Invalid input: Should pass single schema",
      });
    }
  }).describe("Filter by status. Can be a single status or array of statuses").optional(), "start_date": z.string().regex(new RegExp("^\\d{4}-\\d{2}-\\d{2}$")).describe("Start date for reporting period (YYYY-MM-DD)").optional(), "end_date": z.string().regex(new RegExp("^\\d{4}-\\d{2}-\\d{2}$")).describe("End date for reporting period (YYYY-MM-DD)").optional() }).strict().describe("Request parameters for retrieving comprehensive delivery metrics")


// get_media_buy_delivery response
export const GetMediaBuyDeliveryResponseSchema = z.object({ "notification_type": z.enum(["scheduled","final","delayed","adjusted"]).describe("Type of webhook notification (only present in webhook deliveries): scheduled = regular periodic update, final = campaign completed, delayed = data not yet available, adjusted = resending period with updated data").optional(), "partial_data": z.boolean().describe("Indicates if any media buys in this webhook have missing/delayed data (only present in webhook deliveries)").optional(), "unavailable_count": z.number().int().gte(0).describe("Number of media buys with reporting_delayed or failed status (only present in webhook deliveries when partial_data is true)").optional(), "sequence_number": z.number().int().gte(1).describe("Sequential notification number (only present in webhook deliveries, starts at 1)").optional(), "next_expected_at": z.string().datetime({ offset: true }).describe("ISO 8601 timestamp for next expected notification (only present in webhook deliveries when notification_type is not 'final')").optional(), "reporting_period": z.object({ "start": z.string().datetime({ offset: true }).describe("ISO 8601 start timestamp in UTC (e.g., 2024-02-05T00:00:00Z)"), "end": z.string().datetime({ offset: true }).describe("ISO 8601 end timestamp in UTC (e.g., 2024-02-05T23:59:59Z)") }).strict().describe("Date range for the report. All periods use UTC timezone."), "currency": z.string().regex(new RegExp("^[A-Z]{3}$")).describe("ISO 4217 currency code"), "aggregated_totals": z.object({ "impressions": z.number().gte(0).describe("Total impressions delivered across all media buys"), "spend": z.number().gte(0).describe("Total amount spent across all media buys"), "clicks": z.number().gte(0).describe("Total clicks across all media buys (if applicable)").optional(), "video_completions": z.number().gte(0).describe("Total video completions across all media buys (if applicable)").optional(), "media_buy_count": z.number().int().gte(0).describe("Number of media buys included in the response") }).strict().describe("Combined metrics across all returned media buys. Only included in API responses (get_media_buy_delivery), not in webhook notifications.").optional(), "media_buy_deliveries": z.array(z.object({ "media_buy_id": z.string().describe("Publisher's media buy identifier"), "buyer_ref": z.string().describe("Buyer's reference identifier for this media buy").optional(), "status": z.enum(["pending","active","paused","completed","failed","reporting_delayed"]).describe("Current media buy status. In webhook context, reporting_delayed indicates data temporarily unavailable."), "expected_availability": z.string().datetime({ offset: true }).describe("When delayed data is expected to be available (only present when status is reporting_delayed)").optional(), "is_adjusted": z.boolean().describe("Indicates this delivery contains updated data for a previously reported period. Buyer should replace previous period data with these totals.").optional(), "pricing_model": z.any().describe("Pricing model used for this media buy").optional(), "totals": z.intersection(z.any(), z.object({ "effective_rate": z.number().gte(0).describe("Effective rate paid per unit based on pricing_model (e.g., actual CPM for 'cpm', actual cost per completed view for 'cpcv', actual cost per point for 'cpp')").optional() }).describe("Aggregate metrics for this media buy across all packages")), "by_package": z.array(z.intersection(z.any(), z.object({ "package_id": z.string().describe("Publisher's package identifier"), "buyer_ref": z.string().describe("Buyer's reference identifier for this package").optional(), "pacing_index": z.number().gte(0).describe("Delivery pace (1.0 = on track, <1.0 = behind, >1.0 = ahead)").optional() }))).describe("Metrics broken down by package"), "daily_breakdown": z.array(z.object({ "date": z.string().regex(new RegExp("^\\d{4}-\\d{2}-\\d{2}$")).describe("Date (YYYY-MM-DD)"), "impressions": z.number().gte(0).describe("Daily impressions"), "spend": z.number().gte(0).describe("Daily spend") }).strict()).describe("Day-by-day delivery").optional() }).strict()).describe("Array of delivery data for media buys. When used in webhook notifications, may contain multiple media buys aggregated by publisher. When used in get_media_buy_delivery API responses, typically contains requested media buys."), "errors": z.array(z.any()).describe("Task-specific errors and warnings (e.g., missing delivery data, reporting platform issues)").optional() }).strict().describe("Response payload for get_media_buy_delivery task")


// list_authorized_properties request
export const ListAuthorizedPropertiesRequestSchema = z.object({ "tags": z.array(z.string().regex(new RegExp("^[a-z0-9_]+$")).describe("Tag to filter by (e.g., 'local_radio', 'premium_content')")).describe("Filter properties by specific tags (optional)").optional() }).strict().describe("Request parameters for discovering all properties this agent is authorized to represent")


// list_authorized_properties response
export const ListAuthorizedPropertiesResponseSchema = z.object({ "properties": z.array(z.any()).describe("Array of all properties this agent is authorized to represent"), "tags": z.record(z.object({ "name": z.string().describe("Human-readable name for this tag"), "description": z.string().describe("Description of what this tag represents") }).strict()).describe("Metadata for each tag referenced by properties").optional(), "primary_channels": z.array(z.any()).min(1).describe("Primary advertising channels represented in this property portfolio. Helps buying agents quickly filter relevance.").optional(), "primary_countries": z.array(z.string().regex(new RegExp("^[A-Z]{2}$"))).min(1).describe("Primary countries (ISO 3166-1 alpha-2 codes) where properties are concentrated. Helps buying agents quickly filter relevance.").optional(), "portfolio_description": z.string().min(1).max(5000).describe("Markdown-formatted description of the property portfolio, including inventory types, audience characteristics, and special features.").optional(), "advertising_policies": z.string().min(1).max(10000).describe("Publisher's advertising content policies, restrictions, and guidelines in natural language. May include prohibited categories, blocked advertisers, restricted tactics, brand safety requirements, or links to full policy documentation.").optional(), "errors": z.array(z.any()).describe("Task-specific errors and warnings (e.g., property availability issues)").optional() }).strict().describe("Response payload for list_authorized_properties task")


// provide_performance_feedback request
export const ProvidePerformanceFeedbackRequestSchema = z.object({ "media_buy_id": z.string().min(1).describe("Publisher's media buy identifier"), "measurement_period": z.object({ "start": z.string().datetime({ offset: true }).describe("ISO 8601 start timestamp for measurement period"), "end": z.string().datetime({ offset: true }).describe("ISO 8601 end timestamp for measurement period") }).strict().describe("Time period for performance measurement"), "performance_index": z.number().gte(0).describe("Normalized performance score (0.0 = no value, 1.0 = expected, >1.0 = above expected)"), "package_id": z.string().min(1).describe("Specific package within the media buy (if feedback is package-specific)").optional(), "creative_id": z.string().min(1).describe("Specific creative asset (if feedback is creative-specific)").optional(), "metric_type": z.enum(["overall_performance","conversion_rate","brand_lift","click_through_rate","completion_rate","viewability","brand_safety","cost_efficiency"]).describe("The business metric being measured").default("overall_performance"), "feedback_source": z.enum(["buyer_attribution","third_party_measurement","platform_analytics","verification_partner"]).describe("Source of the performance data").default("buyer_attribution") }).strict().describe("Request payload for provide_performance_feedback task")


// provide_performance_feedback response
export const ProvidePerformanceFeedbackResponseSchema = z.object({ "success": z.boolean().describe("Whether the performance feedback was successfully received"), "errors": z.array(z.any()).describe("Task-specific errors and warnings (e.g., invalid measurement period, missing campaign data)").optional() }).strict().describe("Response payload for provide_performance_feedback task")


// get_signals request
export const GetSignalsRequestSchema = z.object({ "signal_spec": z.string().describe("Natural language description of the desired signals"), "deliver_to": z.object({ "platforms": z.any().superRefine((x, ctx) => {
    const schemas = [z.literal("all"), z.array(z.string())];
    const errors = schemas.reduce<z.ZodError[]>(
      (errors, schema) =>
        ((result) =>
          result.error ? [...errors, result.error] : errors)(
          schema.safeParse(x),
        ),
      [],
    );
    if (schemas.length - errors.length !== 1) {
      ctx.addIssue({
        path: ctx.path,
        code: "invalid_union",
        unionErrors: errors,
        message: "Invalid input: Should pass single schema",
      });
    }
  }).describe("Target platforms for signal deployment"), "accounts": z.array(z.object({ "platform": z.string().describe("Platform identifier"), "account": z.string().describe("Account identifier on that platform") }).strict()).describe("Specific platform-account combinations").optional(), "countries": z.array(z.string().regex(new RegExp("^[A-Z]{2}$"))).describe("Countries where signals will be used (ISO codes)") }).strict().describe("Where the signals need to be delivered"), "filters": z.object({ "catalog_types": z.array(z.enum(["marketplace","custom","owned"])).describe("Filter by catalog type").optional(), "data_providers": z.array(z.string()).describe("Filter by specific data providers").optional(), "max_cpm": z.number().gte(0).describe("Maximum CPM price filter").optional(), "min_coverage_percentage": z.number().gte(0).lte(100).describe("Minimum coverage requirement").optional() }).strict().describe("Filters to refine results").optional(), "max_results": z.number().int().gte(1).describe("Maximum number of results to return").optional() }).strict().describe("Request parameters for discovering signals based on description")


// get_signals response
export const GetSignalsResponseSchema = z.object({ "signals": z.array(z.object({ "signal_agent_segment_id": z.string().describe("Unique identifier for the signal"), "name": z.string().describe("Human-readable signal name"), "description": z.string().describe("Detailed signal description"), "signal_type": z.enum(["marketplace","custom","owned"]).describe("Type of signal"), "data_provider": z.string().describe("Name of the data provider"), "coverage_percentage": z.number().gte(0).lte(100).describe("Percentage of audience coverage"), "deployments": z.array(z.object({ "platform": z.string().describe("Platform name"), "account": z.union([z.string().describe("Specific account if applicable"), z.null().describe("Specific account if applicable")]).describe("Specific account if applicable").optional(), "is_live": z.boolean().describe("Whether signal is currently active"), "scope": z.enum(["platform-wide","account-specific"]).describe("Deployment scope"), "decisioning_platform_segment_id": z.string().describe("Platform-specific segment ID").optional(), "estimated_activation_duration_minutes": z.number().gte(0).describe("Time to activate if not live").optional() }).strict()).describe("Array of platform deployments"), "pricing": z.object({ "cpm": z.number().gte(0).describe("Cost per thousand impressions"), "currency": z.string().regex(new RegExp("^[A-Z]{3}$")).describe("Currency code") }).strict().describe("Pricing information") }).strict()).describe("Array of matching signals"), "errors": z.array(z.any()).describe("Task-specific errors and warnings (e.g., signal discovery or pricing issues)").optional() }).strict().describe("Response payload for get_signals task")


// activate_signal request
export const ActivateSignalRequestSchema = z.object({ "signal_agent_segment_id": z.string().describe("The universal identifier for the signal to activate"), "platform": z.string().describe("The target platform for activation"), "account": z.string().describe("Account identifier (required for account-specific activation)").optional() }).strict().describe("Request parameters for activating a signal on a specific platform/account")


// activate_signal response
export const ActivateSignalResponseSchema = z.object({ "decisioning_platform_segment_id": z.string().describe("The platform-specific ID to use once activated").optional(), "estimated_activation_duration_minutes": z.number().gte(0).describe("Estimated time to complete (optional)").optional(), "deployed_at": z.string().datetime({ offset: true }).describe("Timestamp when activation completed (optional)").optional(), "errors": z.array(z.any()).describe("Task-specific errors and warnings (e.g., activation failures, platform issues)").optional() }).strict().describe("Response payload for activate_signal task")


