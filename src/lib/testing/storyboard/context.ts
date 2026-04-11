/**
 * Context propagation for storyboard steps.
 *
 * After each successful step, known IDs and references are extracted
 * from the response and accumulated in a StoryboardContext. Before
 * executing a step, context values are injected into the request via
 * "$context.<key>" placeholders.
 *
 * This convention-based approach avoids requiring YAML enrichment
 * (context_outputs/context_inputs) while still enabling stateful flows.
 */

import type { StoryboardContext, ContextOutput, ContextInput } from './types';
import { resolvePath, setPath } from './path';

// ────────────────────────────────────────────────────────────
// Context extraction: pull known IDs from task responses
// ────────────────────────────────────────────────────────────

type ContextExtractor = (data: unknown) => Record<string, unknown>;

export const CONTEXT_EXTRACTORS: Record<string, ContextExtractor> = {
  sync_accounts(data) {
    const d = data as Record<string, unknown> | undefined;
    const accounts = d?.accounts as Array<Record<string, unknown>> | undefined;
    if (!accounts?.[0]) return {};
    const first = accounts[0];
    const extracted: Record<string, unknown> = {};
    if (first.account_id) extracted.account_id = first.account_id;
    if (first.status) extracted.account_status = first.status;
    // Build an account reference for downstream steps
    extracted.account = {
      brand: first.brand,
      operator: first.operator,
    };
    return extracted;
  },

  list_accounts(data) {
    const d = data as Record<string, unknown> | undefined;
    const accounts = d?.accounts as Array<Record<string, unknown>> | undefined;
    if (!accounts?.[0]) return {};
    return { account_id: accounts[0].account_id };
  },

  get_products(data) {
    const d = data as Record<string, unknown> | undefined;
    const products = d?.products as Array<Record<string, unknown>> | undefined;
    if (!products?.[0]) return {};
    const extracted: Record<string, unknown> = { products };
    if (products[0].product_id) extracted.product_id = products[0].product_id;
    // Extract proposal_id if proposals are returned
    const proposals = d?.proposals as Array<Record<string, unknown>> | undefined;
    if (proposals?.[0]?.proposal_id) extracted.proposal_id = proposals[0].proposal_id;
    return extracted;
  },

  create_media_buy(data) {
    const d = data as Record<string, unknown> | undefined;
    const extracted: Record<string, unknown> = {};
    if (d?.media_buy_id) extracted.media_buy_id = d.media_buy_id;
    if (d?.status) extracted.media_buy_status = d.status;
    return extracted;
  },

  update_media_buy(data) {
    const d = data as Record<string, unknown> | undefined;
    const extracted: Record<string, unknown> = {};
    if (d?.media_buy_id) extracted.media_buy_id = d.media_buy_id;
    if (d?.status) extracted.media_buy_status = d.status;
    return extracted;
  },

  get_media_buys(data) {
    const d = data as Record<string, unknown> | undefined;
    const buys = d?.media_buys as Array<Record<string, unknown>> | undefined;
    if (!buys?.[0]) return {};
    return {
      media_buy_id: buys[0].media_buy_id,
      media_buy_status: buys[0].status,
    };
  },

  list_creative_formats(data) {
    const d = data as Record<string, unknown> | undefined;
    const formats = d?.formats as Array<Record<string, unknown>> | undefined;
    if (!formats?.[0]) return {};
    return {
      formats,
      format_id: formats[0].format_id,
    };
  },

  build_creative(data) {
    const d = data as Record<string, unknown> | undefined;
    const extracted: Record<string, unknown> = {};
    // Single response: creative_manifest
    const manifest = d?.creative_manifest as Record<string, unknown> | undefined;
    if (manifest) {
      extracted.creative_manifest = manifest;
      if (manifest.format_id) extracted.format_id = manifest.format_id;
    }
    // Multi response: creative_manifests
    const manifests = d?.creative_manifests as Array<Record<string, unknown>> | undefined;
    if (manifests?.[0]) {
      extracted.creative_manifests = manifests;
      if (manifests[0].format_id) extracted.format_id = manifests[0].format_id;
    }
    return extracted;
  },

  sync_creatives(data) {
    const d = data as Record<string, unknown> | undefined;
    const results = d?.creatives as Array<Record<string, unknown>> | undefined;
    if (!results?.length) return {};
    return { creative_results: results };
  },

  list_creatives(data) {
    const d = data as Record<string, unknown> | undefined;
    const creatives = d?.creatives as Array<Record<string, unknown>> | undefined;
    if (!creatives?.[0]) return {};
    const extracted: Record<string, unknown> = { creatives };
    if (creatives[0].creative_id) extracted.creative_id = creatives[0].creative_id;
    return extracted;
  },

  preview_creative(data) {
    const d = data as Record<string, unknown> | undefined;
    const previews = d?.previews as Array<Record<string, unknown>> | undefined;
    if (!previews?.length) return {};
    return { previews };
  },

  get_signals(data) {
    const d = data as Record<string, unknown> | undefined;
    const signals = d?.signals as Array<Record<string, unknown>> | undefined;
    if (!signals?.[0]) return {};
    return {
      signals,
      signal_id: signals[0].signal_id,
    };
  },

  activate_signal(data) {
    const d = data as Record<string, unknown> | undefined;
    const deployments = d?.deployments as Array<Record<string, unknown>> | undefined;
    if (!deployments?.[0]) return {};
    const first = deployments[0];
    const extracted: Record<string, unknown> = { deployments };
    if (first.activation_key) extracted.activation_key = first.activation_key;
    if (first.type) extracted.deployment_type = first.type;
    return extracted;
  },

  sync_catalogs(data) {
    const d = data as Record<string, unknown> | undefined;
    const catalogs = d?.catalogs as Array<Record<string, unknown>> | undefined;
    if (!catalogs?.[0]) return {};
    const extracted: Record<string, unknown> = { catalogs };
    if (catalogs[0].catalog_id) extracted.catalog_id = catalogs[0].catalog_id;
    return extracted;
  },

  sync_audiences(data) {
    const d = data as Record<string, unknown> | undefined;
    const audiences = d?.audiences as Array<Record<string, unknown>> | undefined;
    if (!audiences?.[0]) return {};
    const extracted: Record<string, unknown> = { audiences };
    if (audiences[0].audience_id) extracted.audience_id = audiences[0].audience_id;
    return extracted;
  },

  sync_event_sources(data) {
    const d = data as Record<string, unknown> | undefined;
    const sources = d?.event_sources as Array<Record<string, unknown>> | undefined;
    if (!sources?.[0]) return {};
    const extracted: Record<string, unknown> = { event_sources: sources };
    if (sources[0].event_source_id) extracted.event_source_id = sources[0].event_source_id;
    return extracted;
  },

  si_initiate_session(data) {
    const d = data as Record<string, unknown> | undefined;
    const extracted: Record<string, unknown> = {};
    if (d?.session_id) extracted.session_id = d.session_id;
    return extracted;
  },

  si_get_offering(data) {
    const d = data as Record<string, unknown> | undefined;
    const extracted: Record<string, unknown> = {};
    if (d?.offering_id) extracted.offering_id = d.offering_id;
    const offerings = d?.offerings as Array<Record<string, unknown>> | undefined;
    if (offerings?.[0]?.offering_id) extracted.offering_id = offerings[0].offering_id;
    return extracted;
  },

  sync_plans(data) {
    const d = data as Record<string, unknown> | undefined;
    const plans = d?.plans as Array<Record<string, unknown>> | undefined;
    if (!plans?.[0]) return {};
    return { plan_id: plans[0].plan_id };
  },

  create_property_list(data) {
    const d = data as Record<string, unknown> | undefined;
    const list = d?.list as Record<string, unknown> | undefined;
    if (!list) return {};
    const extracted: Record<string, unknown> = {};
    if (list.list_id) extracted.property_list_id = list.list_id;
    if (list.name) extracted.property_list_name = list.name;
    // auth_token intentionally not extracted — avoid leaking credentials into
    // storyboard context which may appear in logs or compliance reports.
    return extracted;
  },

  create_content_standards(data) {
    const d = data as Record<string, unknown> | undefined;
    if (!d?.standards_id) return {};
    return { content_standards_id: d.standards_id };
  },

  get_rights(data) {
    const d = data as Record<string, unknown> | undefined;
    const rights = d?.rights as Array<Record<string, unknown>> | undefined;
    if (!rights?.[0]?.rights_id) return {};
    return { rights_id: rights[0].rights_id };
  },

  acquire_rights(data) {
    const d = data as Record<string, unknown> | undefined;
    if (!d?.rights_grant_id) return {};
    return { rights_grant_id: d.rights_grant_id, rights_id: d.rights_id };
  },

  sync_governance(data) {
    // Governance registration — no IDs to extract, just confirmation
    return { governance_synced: true, governance_response: data };
  },

  check_governance(data) {
    const d = data as Record<string, unknown> | undefined;
    const extracted: Record<string, unknown> = {};
    if (d?.governance_context) extracted.governance_context = d.governance_context;
    if (d?.check_id) extracted.check_id = d.check_id;
    if (d?.plan_id) extracted.plan_id = d.plan_id;
    if (d?.status) extracted.governance_status = d.status;
    return extracted;
  },

  report_plan_outcome(data) {
    const d = data as Record<string, unknown> | undefined;
    const extracted: Record<string, unknown> = {};
    if (d?.outcome_id) extracted.outcome_id = d.outcome_id;
    if (d?.status) extracted.outcome_status = d.status;
    return extracted;
  },
};

/**
 * Extract context values from a task response.
 */
export function extractContext(taskName: string, data: unknown): Record<string, unknown> {
  const extractor = CONTEXT_EXTRACTORS[taskName];
  if (!extractor) return {};
  try {
    return extractor(data);
  } catch {
    return {};
  }
}

// ────────────────────────────────────────────────────────────
// Context injection: substitute $context.<key> in requests
// ────────────────────────────────────────────────────────────

/**
 * Deep-walk an object and replace "$context.<key>" string values
 * with the corresponding value from context.
 *
 * Returns a new object (does not mutate the input).
 */
export function injectContext(obj: Record<string, unknown>, context: StoryboardContext): Record<string, unknown> {
  return deepReplace(obj, context) as Record<string, unknown>;
}

function deepReplace(value: unknown, context: StoryboardContext): unknown {
  if (typeof value === 'string') {
    const match = value.match(/^\$context\.(\w+)$/);
    if (match?.[1]) {
      const key = match[1];
      return key in context ? context[key] : value;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => deepReplace(item, context));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = deepReplace(v, context);
    }
    return result;
  }

  return value;
}

// ────────────────────────────────────────────────────────────
// Explicit context_outputs: extract values by path
// ────────────────────────────────────────────────────────────

/**
 * Apply explicit context_outputs rules to extract values from response data.
 */
export function applyContextOutputs(data: unknown, outputs: ContextOutput[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const output of outputs) {
    const value = resolvePath(data, output.path);
    if (value !== undefined && value !== null) {
      result[output.key] = value;
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────
// Explicit context_inputs: inject values into request by path
// ────────────────────────────────────────────────────────────

/**
 * Apply explicit context_inputs rules to inject context values into a request.
 * Returns a new object (does not mutate the input).
 */
export function applyContextInputs(
  request: Record<string, unknown>,
  inputs: ContextInput[],
  context: StoryboardContext
): Record<string, unknown> {
  const result = structuredClone(request);
  for (const input of inputs) {
    if (input.key in context) {
      setPath(result, input.inject_at, context[input.key]);
    }
  }
  return result;
}

// setPath is re-exported from ./path for backwards compat
export { setPath } from './path';
