/**
 * Reviewed non-JSON-Schema semantics from the 3.2 beta.8 / rc.2 / rc.3 / rc.4 / rc.6 bundles.
 * These are semantic contracts, NOT a binding-field allowlist: properties and
 * comparison always come from the selected runtime schema. Additions to these
 * annotations require a deliberate implementation/review instead of AJV silently
 * ignoring a new contract. See docs/guides/PROPOSAL-TERMS-VERIFICATION.md.
 */
export const REVIEWED_COMMERCIAL_TERMS_SEMANTICS: Readonly<Record<string, unknown>> = {
  'media-buy/commercial-terms.json': {
    verifier_constraints: {
      pricing_integrity: {
        pricing_option_ids: 'each_purchase.pricing_option_id_equals_pricing.pricing_option_id',
        purchase_currencies: 'all_purchase.pricing.currency_equal',
        total_budget_currency: 'when_total_budget_present_equals_purchase_pricing_currency',
        monetary_fields: 'purchase_budget_min_spend_and_bidding_use_purchase_pricing_currency',
        on_violation: 'reject_proposal_or_commitment',
      },
    },
  },
  'media-buy/commercial-terms.json/properties/purchases': {
    verifier_constraints: {
      resolved_purchase_terms:
        'Each purchase carries resolved start_time and end_time. Applicable measurement_terms and performance_standards are copied from the published offer or negotiated successor; omission means no such terms apply.',
    },
  },
  'media-buy/product-purchase.json': {
    verifier_constraints: {
      direct_purchase_terms:
        'On buy_products, supplied start_time, end_time, measurement_terms, and performance_standards MUST exactly match the selected published offer; omission inherits that offer.',
      accepted_snapshot_terms:
        'Inside canonical-proposal.commercial_terms, each purchase MUST carry resolved start_time and end_time and MUST preserve every applicable measurement term and performance standard. Omission of measurement_terms or performance_standards means the accepted offer declared none.',
      pricing_identity: {
        pricing_option_id: 'equals_pricing.pricing_option_id_when_pricing_present',
        on_violation: 'reject_before_commitment',
      },
    },
  },
  'core/targeting.json': {
    disjoint_place_fields: {
      include: 'geo_places',
      exclude: 'geo_places_exclude',
      identity: ['country', 'system', 'place_type', 'value'],
    },
    description:
      'JSON Schema draft-07 cannot compare values across sibling arrays. Conformance tooling MUST reject any place identity present in both geo_places and geo_places_exclude. Catalog version is deliberately not part of place identity: a stable ID cannot be both included and excluded by assigning different versions.',
  },
  'core/targeting.json/properties/geo_regions_exclude': {
    disjoint_with: 'geo_regions',
    spec: 'docs/media-buy/advanced-topics/targeting.mdx#geo_regions_exclude',
  },
  'core/geo-place-area.json': {
    map_keys_subset_of_array: {
      map_field: 'value_labels',
      array_field: 'values',
    },
    description:
      'Every value_labels key MUST also appear in values. JSON Schema draft-07 cannot express this sibling-field key membership constraint, so conformance tooling must enforce it.',
  },
  'core/locale-tag.json': {
    verifier_constraints: {
      well_formed: 'rfc5646',
      semantic_scope: 'language_identity_only',
      canonical_wire_profile: 'adcp_bcp47_casing',
      rfc5646_comparison: 'case_insensitive',
      non_profile: 'reject',
    },
    spec: 'docs/protocol/language-and-localization.mdx#one-language-tag-primitive',
  },
  'core/iana-timezone.json': {
    iana_timezone: 'value_must_resolve_in_the_implementations_supported_IANA_TZDB',
  },
  'media-buy/commercial-terms.json/properties/change_terms': {
    unique_by: 'action',
  },
  'media-buy/change-term.json': {
    verifier_constraints: {
      allowed_statuses:
        'Every value is a non-terminal MediaBuy status. The current buy projection omits the action outside these statuses without extinguishing the negotiated right.',
      constraint_action_compatibility: {
        budget: [
          'increase_budget',
          'decrease_budget',
          'reallocate_budget',
          'update_budget_allocation',
          'update_spend_target',
        ],
        flight: ['extend_flight', 'shorten_flight', 'update_flight_dates'],
        package_count: ['add_packages', 'remove_packages'],
        effective_timing: ['pause', 'resume', 'cancel'],
        on_violation: 'reject_proposal',
      },
      constraint_currency: 'Every monetary constraint currency equals the commercial terms purchase currency.',
      constraint_consistency:
        'Minimum result does not exceed maximum result; earliest timestamp does not exceed latest timestamp.',
    },
  },
};

/** Contracts absent from a deliberately supported historical schema graph. */
export const ABSENT_COMMERCIAL_CONTRACTS_BY_RELEASE: Readonly<Record<string, readonly string[]>> = {
  '3.2.0-beta.8': [
    'media-buy/commercial-terms.json/properties/change_terms',
    'media-buy/change-term.json',
    'core/iana-timezone.json',
  ],
};

/** rc.3 removes direct buy_products matching from the accepted snapshot contract. */
export const COMMERCIAL_SEMANTIC_OVERRIDES_BY_RELEASE: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  '3.2.0-rc.3': {
    'media-buy/product-purchase.json': {
      verifier_constraints: {
        accepted_snapshot_terms:
          'Inside canonical-proposal.commercial_terms, each purchase MUST carry resolved start_time and end_time and MUST preserve every applicable measurement term and performance standard. Omission of measurement_terms or performance_standards means the accepted offer declared none.',
        pricing_identity: {
          pricing_option_id: 'equals_pricing.pricing_option_id_when_pricing_present',
          on_violation: 'reject_before_commitment',
        },
      },
    },
  },
  '3.2.0-rc.4': {
    'media-buy/product-purchase.json': {
      verifier_constraints: {
        accepted_snapshot_terms:
          'Inside canonical-proposal.commercial_terms, each purchase MUST carry resolved start_time and end_time and MUST preserve every applicable measurement term and performance standard. Omission of measurement_terms or performance_standards means the accepted offer declared none.',
        pricing_identity: {
          pricing_option_id: 'equals_pricing.pricing_option_id_when_pricing_present',
          on_violation: 'reject_before_commitment',
        },
      },
    },
  },
  '3.2.0-rc.6': {
    'media-buy/product-purchase.json': {
      verifier_constraints: {
        accepted_snapshot_terms:
          'Inside canonical-proposal.commercial_terms, each purchase MUST carry resolved start_time and end_time and MUST preserve every applicable measurement term and performance standard. Omission of measurement_terms or performance_standards means the accepted offer declared none.',
        pricing_identity: {
          pricing_option_id: 'equals_pricing.pricing_option_id_when_pricing_present',
          on_violation: 'reject_before_commitment',
        },
      },
    },
  },
};

/** Binding snapshots keep JSON Schema enum membership even for extensible taxonomies. */
export const REVIEWED_COMMERCIAL_ENUM_ANNOTATIONS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'enums/advertiser-industry.json': {
    'x-extensible': true,
    'x-pattern': '^[a-z][a-z0-9_]+(\\.[a-z][a-z0-9_]+)?$',
  },
};
