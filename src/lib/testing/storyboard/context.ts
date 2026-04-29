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

import { randomUUID } from 'node:crypto';
import type { StoryboardContext, ContextOutput, ContextInput, ContextProvenanceEntry } from './types';
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
    // Don't extract a single-resource ID from a broad-list page. When
    // has_more: true the caller is mid-pagination walk and buys[0] is not
    // the canonical buy — extracting it here causes the enricher to inject
    // media_buy_ids: [that_id] on the next step, turning a continuation into
    // an ID-lookup. Conservative: === true matches the codebase convention
    // (absent has_more is treated as terminal, not as a list-in-progress).
    const pagination = d?.pagination as Record<string, unknown> | undefined;
    if (pagination?.has_more === true) return {};
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
 * Per-context alias cache for `$generate:uuid_v4#<alias>` placeholders.
 *
 * A WeakMap keyed off the StoryboardContext identity avoids landing
 * implementation-detail keys on the serialized context object and avoids
 * fragility when context is shallow-cloned between steps — the cache
 * follows the context reference rather than riding as an owned key.
 *
 * Propagation across steps is handled by `forwardAliasCache` (called by
 * the runner when it rolls context forward to the next step), keeping
 * this a deliberate design choice rather than an invisible by-reference
 * leak through `{ ...context }`.
 */
const aliasCaches = new WeakMap<StoryboardContext, Record<string, string>>();

/**
 * Ensure an alias cache exists for the given context and return it.
 */
function getAliasCache(context: StoryboardContext): Record<string, string> {
  let cache = aliasCaches.get(context);
  if (!cache) {
    cache = {};
    aliasCaches.set(context, cache);
  }
  return cache;
}

/**
 * Propagate the alias cache from one context to another — call after
 * shallow-cloning context between storyboard steps so replay tests
 * (initial + replay sharing `$generate:uuid_v4#<alias>`) resolve to the
 * same UUID. No-op when `from` has no cache.
 */
export function forwardAliasCache(from: StoryboardContext, to: StoryboardContext): void {
  const cache = aliasCaches.get(from);
  if (cache) aliasCaches.set(to, cache);
}

/**
 * Runner-owned substitution variables.
 *
 * Parallels `$context.*` but lives outside the serialized context object so
 * implementation details (the receiver's bound URL, per-step operation ids)
 * stay off the compliance report. Expanded within strings (embedded
 * substitution), unlike `$context.*` which matches whole strings only.
 *
 * Supported patterns:
 *   - `{{runner.webhook_base}}` — base URL of the receiver.
 *   - `{{runner.webhook_url:<step_id>}}` — per-step webhook URL
 *     (`<base>/step/<step_id>/<operation_id>`). The operation_id is minted
 *     lazily on first expansion and cached for the rest of the run so the
 *     matching `{{prior_step.<step_id>.operation_id}}` reference downstream
 *     resolves to the same value.
 *   - `{{prior_step.<step_id>.operation_id}}` — operation_id the runner
 *     allocated when expanding `{{runner.webhook_url:<step_id>}}`.
 */
export interface RunnerVariables {
  /** Base URL of the runner's webhook receiver, when enabled. */
  webhookBase?: string;
  /** step_id → operation_id, filled lazily on expansion. */
  stepOperationIds: Map<string, string>;
  /**
   * Free-form slot for cross-step run state that isn't user-facing. Used
   * today to share a single `InMemoryReplayStore` / `InMemoryRevocationStore`
   * across every `expect_webhook_signature_valid` call in a run so a
   * replayed (keyid, nonce) across two deliveries of the same event is
   * actually detected. Untyped here to keep the context module free of
   * signing-module imports.
   */
  runState: Map<string, unknown>;
}

export function createRunnerVariables(opts: { webhookBase?: string } = {}): RunnerVariables {
  return {
    ...(opts.webhookBase !== undefined && { webhookBase: opts.webhookBase }),
    stepOperationIds: new Map(),
    runState: new Map(),
  };
}

/**
 * Deep-walk an object and replace recognized placeholder strings:
 *
 * - `$context.<key>` → value from `context[key]` (anchored whole-string match)
 * - `$generate:uuid_v4` → fresh UUID v4 per occurrence (anchored)
 * - `$generate:uuid_v4#<alias>` → fresh UUID v4 on first occurrence, then the
 *   same UUID for every subsequent occurrence of the same alias within this
 *   run (anchored)
 * - `{{runner.*}}` / `{{prior_step.<id>.operation_id}}` → embedded runner-
 *   variable substitution (only when `runnerVars` is supplied)
 *
 * Returns a new object (does not mutate the input).
 */
export function injectContext(
  obj: Record<string, unknown>,
  context: StoryboardContext,
  runnerVars?: RunnerVariables
): Record<string, unknown> {
  return deepReplace(obj, context, runnerVars) as Record<string, unknown>;
}

function deepReplace(value: unknown, context: StoryboardContext, runnerVars?: RunnerVariables): unknown {
  if (typeof value === 'string') {
    // Mustache first — expands in-place within the string, so anchored
    // patterns below still apply to the post-expansion result.
    const expanded = runnerVars ? expandMustache(value, runnerVars) : value;

    const ctxMatch = expanded.match(/^\$context\.(\w+)$/);
    if (ctxMatch?.[1]) {
      const key = ctxMatch[1];
      return key in context ? context[key] : expanded;
    }
    const genMatch = expanded.match(/^\$generate:(uuid_v4|opaque_id)(?:#([A-Za-z0-9_.-]+))?$/);
    if (genMatch) {
      const alias = genMatch[2];
      if (alias) {
        const cache = getAliasCache(context);
        if (!(alias in cache)) cache[alias] = randomUUID();
        return cache[alias];
      }
      return randomUUID();
    }
    return expanded;
  }

  if (Array.isArray(value)) {
    return value.map(item => deepReplace(item, context, runnerVars));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = deepReplace(v, context, runnerVars);
    }
    return result;
  }

  return value;
}

/**
 * Expand every `{{runner.*}}` and `{{prior_step.*}}` token in a string.
 * Unknown tokens are left in place so the runner can surface a pointed
 * "unresolved substitution" error rather than silently shipping the
 * literal mustache tokens to an agent.
 */
/**
 * Token shape for the outer expander. Single `[^{}]+` (excludes braces on
 * both sides) so nested or partial `{{…` can't straddle a token boundary
 * and force the engine to backtrack character-by-character. Unified prefix
 * alternation (`runner|prior_step`) keeps the two recognized names in one
 * place — the inner expander still narrows each. Closes CodeQL alert #49
 * (js/polynomial-redos).
 */
const MUSTACHE_TOKEN_RE = /\{\{((?:runner|prior_step)\.[^{}]+)\}\}/g;

function expandMustache(input: string, runnerVars: RunnerVariables): string {
  return input.replace(MUSTACHE_TOKEN_RE, (match, inner) => {
    if (inner === 'runner.webhook_base') {
      return runnerVars.webhookBase ?? match;
    }
    const webhookUrlMatch = /^runner\.webhook_url:([A-Za-z0-9_]+)$/.exec(inner);
    if (webhookUrlMatch?.[1]) {
      if (!runnerVars.webhookBase) return match;
      const stepId = webhookUrlMatch[1];
      let opId = runnerVars.stepOperationIds.get(stepId);
      if (!opId) {
        opId = randomUUID();
        runnerVars.stepOperationIds.set(stepId, opId);
      }
      return `${runnerVars.webhookBase}/step/${stepId}/${opId}`;
    }
    const priorMatch = /^prior_step\.([A-Za-z0-9_]+)\.operation_id$/.exec(inner);
    if (priorMatch?.[1]) {
      return runnerVars.stepOperationIds.get(priorMatch[1]) ?? match;
    }
    return match;
  });
}

// ────────────────────────────────────────────────────────────
// Explicit context_outputs: extract values by path
// ────────────────────────────────────────────────────────────

/**
 * Apply explicit context_outputs rules to extract values from response data.
 * Entries with `generate` set are skipped — use `applyContextOutputsWithProvenance`
 * (which accepts a context for alias-cache access) to handle those.
 */
export function applyContextOutputs(data: unknown, outputs: ContextOutput[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const output of outputs) {
    if (!output.path) continue;
    const value = resolvePath(data, output.path);
    if (value !== undefined && value !== null) {
      result[output.key] = value;
    }
  }
  return result;
}

/**
 * Result of a context write with per-key provenance. The runner consumes
 * `provenance` to emit `context_value_rejected` hints when a later step's
 * seller response rejects a value that traces back to one of these keys.
 * `values` carries the same Record as the non-provenance call so the
 * runner's downstream `Object.assign(updatedContext, values)` path is
 * unchanged.
 */
export interface ContextWriteResult {
  values: Record<string, unknown>;
  provenance: Record<string, ContextProvenanceEntry>;
}

/**
 * Like `extractContext`, but also returns provenance for each written key
 * tagging it as a convention-based extraction. `response_path` is absent
 * for convention extractors — they're hardcoded functions, not YAML paths.
 */
export function extractContextWithProvenance(taskName: string, data: unknown, stepId: string): ContextWriteResult {
  const values = extractContext(taskName, data);
  const provenance: Record<string, ContextProvenanceEntry> = {};
  for (const key of Object.keys(values)) {
    provenance[key] = {
      source_step_id: stepId,
      source_kind: 'convention',
      source_task: taskName,
    };
  }
  return { values, provenance };
}

/**
 * Like `applyContextOutputs`, but also returns provenance for each written
 * key carrying the YAML `response_path` so diagnostics can cite it verbatim.
 *
 * Pass `context` to enable `generate:` entries with alias-cache coherence.
 * When an output declares `generate`, the runner mints a UUID v4 (or reuses
 * the value already cached under `output.key` if an inline `$generate:…#<alias>`
 * substitution ran in the same step). The generated value is written back into
 * the alias cache so that any later step referencing `$generate:opaque_id#<key>`
 * resolves to the same UUID.
 *
 * Omitting `context` disables alias-cache coherence: each generator entry mints
 * an independent UUID that cannot be matched by an inline `$generate:…` form.
 *
 * Generator entries fire regardless of whether `data` is present; path
 * entries are silently skipped when the resolved value is null/undefined.
 */
export function applyContextOutputsWithProvenance(
  data: unknown,
  outputs: ContextOutput[],
  stepId: string,
  taskName: string,
  context?: StoryboardContext
): ContextWriteResult {
  const values: Record<string, unknown> = {};
  const provenance: Record<string, ContextProvenanceEntry> = {};
  for (const output of outputs) {
    if (output.generate !== undefined) {
      // Generator entries require a context — without one the alias cache
      // can't be populated, so a later step's `$generate:opaque_id#<key>` would
      // mint an independent UUID that doesn't match the value stored here.
      // Loud error beats silent divergence.
      if (!context) {
        throw new Error(
          `applyContextOutputsWithProvenance: context_outputs entry '${output.key}' ` +
            `declares generate='${output.generate}' but no context was provided. ` +
            `Generator entries require a context for alias-cache coherence.`
        );
      }
      const cache = getAliasCache(context);
      let value: string;
      if (output.key in cache) {
        value = cache[output.key]!;
      } else {
        value = randomUUID();
        cache[output.key] = value;
      }
      values[output.key] = value;
      provenance[output.key] = {
        source_step_id: stepId,
        source_kind: 'generator',
        source_task: taskName,
      };
    } else if (output.path) {
      const value = resolvePath(data, output.path);
      if (value !== undefined && value !== null) {
        values[output.key] = value;
        provenance[output.key] = {
          source_step_id: stepId,
          source_kind: 'context_outputs',
          response_path: output.path,
          source_task: taskName,
        };
      }
    }
  }
  return { values, provenance };
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
