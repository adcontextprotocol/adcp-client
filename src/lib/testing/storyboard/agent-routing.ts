/**
 * Per-specialism agent routing for the storyboard runner (#1066).
 *
 * Resolves each step's `task` to one of N agents in
 * `StoryboardRunOptions.agents` so storyboards that span specialisms
 * (e.g., a `signal_marketplace/governance_denied` flow that calls
 * `sync_governance` then `activate_signal`) can hit the tenant that
 * actually owns each tool.
 *
 * Resolution order per step:
 *   1. Explicit `step.agent` (escape hatch for cross-domain tools)
 *   2. `TASK_FEATURE_MAP` → first protocol → unique claimant in the agents map
 *   3. `options.default_agent`
 *   4. Throw `RoutingError`
 *
 * Multi-claim conflicts (two agents claim the same protocol AND a step
 * relying on that protocol lacks an explicit `agent:` override) fail-fast
 * at routing-context build time, BEFORE any non-discovery network calls.
 *
 * ## Webhook receiver topology in routed mode
 *
 * When `StoryboardRunOptions.webhook_receiver` is set alongside `agents`,
 * the receiver is **shared** across all tenants — one HTTP server, one base
 * URL. The runner does not create per-tenant receivers and does not need to:
 * delivery correlation is by **step-keyed URL** (`/step/<step_id>/<op_id>`),
 * not by source agent. If both a governance tenant and a signals tenant
 * emit webhooks during the same run, the assertion harness matches each
 * delivery to its `expect_webhook*` step by URL path, regardless of which
 * tenant posted it. This means:
 *
 *   - `{{runner.webhook_base}}` substitutes the same URL for every step
 *     across all agents — no per-agent variable needed.
 *   - `{{runner.webhook_url:<step_id>}}` is always sufficient to pin a
 *     delivery to the step that requested it, even when multiple tenants
 *     emit concurrently.
 *   - Per-tenant receivers are not supported; if a future storyboard needs
 *     delivery-source disambiguation, use distinct step IDs (they already
 *     produce distinct URL paths).
 *
 * See `StoryboardRunOptions.webhook_receiver` JSDoc and `webhook-receiver.ts`
 * for implementation details.
 */
import type { TestClient } from '../client';
import { getOrCreateClient, getOrDiscoverProfile } from '../client';
import type { AgentProfile } from '../types';
import { TASK_FEATURE_MAP, type AdcpProtocol } from '../../utils/capabilities';
import type { AgentEntry, Storyboard, StoryboardRunOptions, StoryboardStep } from './types';

// `compliance_testing` is on the wire as a top-level capability block, NOT
// in `supported_protocols`. `parseCapabilitiesResponse`
// (`src/lib/utils/capabilities.ts`) normalizes the block into the
// `protocols[]` list before `getOrDiscoverProfile` writes it onto the
// profile, so by the time routing reads `profile.supported_protocols`
// the value is present. Any future refactor that strips that
// normalization needs to either preserve it or drop `compliance_testing`
// from this set.
const KNOWN_PROTOCOLS: ReadonlySet<AdcpProtocol> = new Set([
  'media_buy',
  'signals',
  'governance',
  'creative',
  'sponsored_intelligence',
  'trusted_match',
  'compliance_testing',
  'brand',
]);

/**
 * Redact common auth-token patterns before propagating an upstream error
 * message into runner output / CI logs / `StoryboardResult.error`. The
 * concrete leak path: a misconfigured agent that echoes its received
 * `Authorization: Bearer <token>` header in a 401 body would put the
 * caller's own bearer for that tenant into CI artifacts. The bearer is
 * already in the caller's CI environment, so this is parity with single-
 * agent mode rather than a fix for a new leak — but defense-in-depth is
 * cheap and the regex is bounded.
 *
 * Patterns covered:
 *   - `Authorization: Bearer <token>` (any case, common in 401 echoes)
 *   - `Bearer <token>` standalone
 *   - `?token=<value>` / `&token=<value>` query-string tokens
 *
 * Best-effort. Anything unusual (custom-header schemes, base64-encoded
 * blobs in JSON bodies) is not caught — operators should still treat
 * upstream-error CI logs as sensitive.
 */
function scrubAuthSecrets(text: string): string {
  // The character class `[A-Za-z0-9._~+/=-]+` looks like high-entropy
  // content to entropy-based secret scanners (GitGuardian/gitleaks). It
  // is the redaction pattern itself — no secret is encoded here.
  // ggignore
  return text
    .replace(/(authorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]') // ggignore
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]') // ggignore
    .replace(/([?&]token=)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'); // ggignore
}

/** Per-agent options view: per-entry overrides shadow run-level defaults. */
function buildAgentOptions(entry: AgentEntry, options: StoryboardRunOptions): StoryboardRunOptions {
  return {
    ...options,
    auth: entry.auth ?? options.auth,
    protocol: entry.transport ?? options.protocol,
    // _client, _profile, and agents are run-scoped — never inherit into
    // per-agent views. `_profile` is the load-bearing one: when comply()
    // sets it on the run-level options, `getOrDiscoverProfile` (`client.ts`)
    // short-circuits to that cached profile and skips the actual probe.
    // Without this clear, every per-agent discovery would return
    // comply()'s primary-tenant profile instead of probing the real
    // tenant — silently breaking the protocol-claim index that routing
    // depends on.
    _client: undefined,
    _profile: undefined,
    agents: undefined,
    agentTools: undefined,
  };
}

export interface AgentRoutingContext {
  /** Per-agent transport client. Lifecycle owned by the runner. */
  clients: Map<string, TestClient>;
  /** Per-agent discovered profile (`get_adcp_capabilities` result). */
  profiles: Map<string, AgentProfile>;
  /** Protocol → keys of agents that claim it. */
  protocolIndex: Map<AdcpProtocol, string[]>;
  /** Resolved (key → URL) for echo on the storyboard result. */
  agentMap: Record<string, string>;
}

export class RoutingError extends Error {
  constructor(
    message: string,
    public readonly task: string,
    public readonly hint: string
  ) {
    super(message);
    this.name = 'RoutingError';
  }
}

export class DiscoveryFailure extends Error {
  constructor(
    message: string,
    public readonly agentKey: string,
    public readonly url: string,
    public readonly underlying: string
  ) {
    super(message);
    this.name = 'DiscoveryFailure';
  }
}

/**
 * Discover every agent in the map in parallel and build the routing index.
 *
 * Failure modes:
 *   - any agent's discovery fails → `DiscoveryFailure` (caller surfaces as
 *     a hard storyboard failure, never a per-step skip)
 *   - protocol claimed by 2+ agents AND ≥1 storyboard step that needs it
 *     lacks `step.agent` → `RoutingError` (conflict)
 */
export async function buildRoutingContext(
  storyboard: Storyboard,
  options: StoryboardRunOptions
): Promise<AgentRoutingContext> {
  const agents = options.agents!;
  const entries = Object.entries(agents);

  const clients = new Map<string, TestClient>();
  const agentMap: Record<string, string> = {};
  for (const [key, entry] of entries) {
    const perAgentOptions = buildAgentOptions(entry, options);
    clients.set(key, getOrCreateClient(entry.url, perAgentOptions));
    agentMap[key] = entry.url;
  }

  // Parallel discovery — one tenant's slowness does not block another.
  const profiles = new Map<string, AgentProfile>();
  const discoveryResults = await Promise.all(
    entries.map(async ([key, entry]) => {
      const perAgentOptions = buildAgentOptions(entry, options);
      try {
        const { profile, step } = await getOrDiscoverProfile(clients.get(key)!, perAgentOptions);
        return { key, profile, step };
      } catch (err) {
        return {
          key,
          profile: undefined,
          step: {
            step: 'Discover agent capabilities',
            passed: false,
            error: scrubAuthSecrets((err as Error)?.message || String(err)),
          },
        };
      }
    })
  );
  for (const r of discoveryResults) {
    if (!r.profile || r.step.passed === false) {
      const detail = scrubAuthSecrets(r.step.error ?? 'Discovery returned no profile.');
      throw new DiscoveryFailure(
        `Discovery failed for agent "${r.key}" (${agents[r.key]!.url}): ${detail}`,
        r.key,
        agents[r.key]!.url,
        detail
      );
    }
    profiles.set(r.key, r.profile);
  }

  const protocolIndex = buildProtocolIndex(profiles);
  detectMultiClaimConflicts(storyboard, protocolIndex);

  return { clients, profiles, protocolIndex, agentMap };
}

/**
 * Test seam: build a routing context from pre-baked profiles instead of
 * running discovery. Lets unit tests exercise conflict detection and
 * per-step resolution without spinning up live agents. Production code
 * uses `buildRoutingContext`; this entry point is exported for the
 * `agent-routing.test.js` harness.
 */
export function buildRoutingContextFromProfiles(
  storyboard: Storyboard,
  options: StoryboardRunOptions,
  profiles: Map<string, AgentProfile>
): AgentRoutingContext {
  const agents = options.agents!;
  const agentMap: Record<string, string> = {};
  for (const [key, entry] of Object.entries(agents)) {
    agentMap[key] = entry.url;
  }
  const protocolIndex = buildProtocolIndex(profiles);
  detectMultiClaimConflicts(storyboard, protocolIndex);
  // Empty client map — callers that only test routing shouldn't dispatch.
  return { clients: new Map(), profiles, protocolIndex, agentMap };
}

/**
 * Reverse-index `AgentProfile.supported_protocols` so routing can pick an
 * agent by tool→protocol→agent in O(1).
 *
 * Sorts the agent-key list per protocol for deterministic conflict-error
 * output and reproducible tests.
 */
function buildProtocolIndex(profiles: Map<string, AgentProfile>): Map<AdcpProtocol, string[]> {
  const index = new Map<AdcpProtocol, string[]>();
  for (const [key, profile] of profiles) {
    const protocols = profile.supported_protocols ?? [];
    for (const p of protocols) {
      if (!KNOWN_PROTOCOLS.has(p as AdcpProtocol)) continue;
      const proto = p as AdcpProtocol;
      const list = index.get(proto) ?? [];
      list.push(key);
      index.set(proto, list);
    }
  }
  for (const list of index.values()) list.sort();
  return index;
}

/**
 * Walk the storyboard once and surface any tool→protocol resolution that
 * has 2+ candidate agents AND no explicit `step.agent` override.
 *
 * We could defer this to per-step routing time, but a multi-claim is
 * almost always a topology bug (two tenants accidentally claiming the
 * same protocol) — surfacing it before the first non-discovery network
 * call gives a much better error than a half-run storyboard.
 */
function detectMultiClaimConflicts(storyboard: Storyboard, protocolIndex: Map<AdcpProtocol, string[]>): void {
  const conflicts: Array<{ task: string; protocol: AdcpProtocol; agents: string[]; stepIds: string[] }> = [];
  for (const phase of storyboard.phases ?? []) {
    for (const step of phase.steps ?? []) {
      if (step.agent !== undefined) continue;
      const protocol = primaryProtocolFor(step.task);
      if (!protocol) continue;
      const candidates = protocolIndex.get(protocol);
      if (!candidates || candidates.length < 2) continue;
      const existing = conflicts.find(c => c.task === step.task && c.protocol === protocol);
      if (existing) {
        existing.stepIds.push(step.id);
      } else {
        conflicts.push({
          task: step.task,
          protocol,
          agents: candidates,
          stepIds: [step.id],
        });
      }
    }
  }
  if (conflicts.length === 0) return;

  const lines = conflicts.map(
    c =>
      `  - tool "${c.task}" (protocol ${c.protocol}) is claimed by [${c.agents.join(', ')}] ` +
      `but step(s) [${c.stepIds.join(', ')}] do not declare \`agent:\` override.`
  );
  throw new RoutingError(
    `Routing conflict: multiple agents claim the same protocol and the storyboard ` +
      `does not disambiguate.\n${lines.join('\n')}\n` +
      `Fix: either remove one of the conflicting agents from the map, or add ` +
      `\`agent: <key>\` to each affected step.`,
    conflicts[0]!.task,
    `Conflicting agents: ${conflicts[0]!.agents.join(', ')}`
  );
}

/**
 * First protocol-typed feature in `TASK_FEATURE_MAP[task]`, or `undefined`
 * for tools intentionally unmapped (e.g. `sync_creatives`, which serves
 * both media-buy and creative domains and requires explicit per-step
 * routing in multi-agent mode).
 */
function primaryProtocolFor(task: string): AdcpProtocol | undefined {
  const features = TASK_FEATURE_MAP[task];
  if (!features) return undefined;
  for (const f of features) {
    if (KNOWN_PROTOCOLS.has(f as AdcpProtocol)) return f as AdcpProtocol;
  }
  return undefined;
}

/**
 * Resolve a step to its target agent key. Throws `RoutingError` when no
 * route can be determined; callers convert to a synthetic step result
 * (see Stage 4 in the runner).
 */
export function resolveAgentForStep(
  step: StoryboardStep,
  options: StoryboardRunOptions,
  ctx: AgentRoutingContext
): string {
  if (step.agent !== undefined) {
    // Already validated at runStoryboard entry; trust here.
    return step.agent;
  }
  const protocol = primaryProtocolFor(step.task);
  if (protocol) {
    const candidates = ctx.protocolIndex.get(protocol) ?? [];
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) {
      // Conflict already detected at build time, but `step.agent` is
      // unset here. This branch is unreachable in well-formed runs; keep
      // it as a fail-loud sanity check.
      throw new RoutingError(
        `Internal: step "${step.id}" task "${step.task}" maps to protocol ` +
          `"${protocol}" claimed by [${candidates.join(', ')}], no step.agent override. ` +
          `This should have been caught at routing-context build time.`,
        step.task,
        `agents: ${candidates.join(', ')}`
      );
    }
    // Zero candidates — no agent in the map claims this protocol.
    if (options.default_agent) return options.default_agent;
    throw new RoutingError(
      `No agent in the map claims protocol "${protocol}" required by tool ` +
        `"${step.task}" (step "${step.id}"). Available agents: ` +
        `${[...ctx.profiles.keys()].join(', ')}. Add an agent that supports ` +
        `${protocol}, or set \`default_agent\` to fall back.`,
      step.task,
      `protocol ${protocol} unclaimed`
    );
  }
  // Tool not in TASK_FEATURE_MAP (e.g., sync_creatives, comply_test_controller,
  // get_adcp_capabilities post-discovery, future tasks).
  if (options.default_agent) return options.default_agent;
  throw new RoutingError(
    `Tool "${step.task}" (step "${step.id}") has no specialism mapping ` +
      `(it serves multiple domains or is unrecognized). Set \`agent: <key>\` ` +
      `on the step, or set \`default_agent\` on the run options.`,
    step.task,
    'no protocol mapping'
  );
}
