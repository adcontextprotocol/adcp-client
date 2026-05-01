// Unified Protocol Interface for AdCP
export { callMCPTool, callMCPToolWithOAuth, connectMCP, closeMCPConnections, UnauthorizedError } from './mcp';

import { closeMCPConnections } from './mcp';
import { closeA2AConnections } from './a2a';

/**
 * Close protocol connections for the given protocol.
 * MCP closes persistent HTTP transports; A2A clears the agent-card client cache.
 */
export async function closeConnections(protocol: 'mcp' | 'a2a' = 'mcp'): Promise<void> {
  if (protocol === 'mcp') {
    await closeMCPConnections();
  } else {
    closeA2AConnections();
  }
}
export type { MCPCallOptions, MCPConnectionResult } from './mcp';
export { callA2ATool } from './a2a';
export {
  callMCPToolWithTasks,
  getMCPTaskStatus,
  getMCPTaskResult,
  listMCPTasks,
  cancelMCPTask,
  mapMCPTaskStatus,
  serverSupportsTasks,
} from './mcp-tasks';

import { callMCPToolWithTasks, callMCPToolWithClient } from './mcp-tasks';
import { callMCPToolWithOAuth } from './mcp';
import { callA2ATool } from './a2a';
import type { AgentConfig, DebugLogEntry } from '../types';
import type { PushNotificationConfig } from '../types/tools.generated';
import { getAuthToken } from '../auth';
import {
  createNonInteractiveOAuthProvider,
  discoverAuthorizationRequirements,
  NeedsAuthorizationError,
  getAgentStorage,
  ensureClientCredentialsTokens,
} from '../auth/oauth';
import { is401Error } from '../errors';
import { isLikelyPrivateUrl } from '../net';
import { validateAgentUrl } from '../validation';
import { withSpan } from '../observability/tracing';
import { ADCP_MAJOR_VERSION, ADCP_VERSION, parseAdcpMajorVersion } from '../version';
import { ConfigurationError } from '../errors';
import { resolveBundleKey } from '../validation/schema-loader';
import { buildAgentSigningContext, CAPABILITY_OP, ensureCapabilityLoaded } from '../signing/client';
import { withResponseSizeLimit } from './responseSizeLimit';

/**
 * Derive the wire-level `adcp_major_version` integer from a caller-supplied
 * pin. Returns the SDK default when no pin is provided; throws on a pin
 * that doesn't parse so misuse surfaces at the factory boundary instead
 * of silently emitting the SDK's major.
 *
 * Throws `ConfigurationError` (not a plain `Error`) so a typo'd pin
 * surfaces with the same error class as the construction-time gate in
 * `resolveAdcpVersion` — one shape for all pin-misuse paths.
 */
function resolveWireMajor(adcpVersion: string | undefined): number {
  if (adcpVersion === undefined) return ADCP_MAJOR_VERSION;
  const parsed = parseAdcpMajorVersion(adcpVersion);
  if (!Number.isFinite(parsed)) {
    throw new ConfigurationError(
      `adcpVersion ${JSON.stringify(adcpVersion)} is not a valid AdCP version. ` +
        `Expected a semver string (e.g. '3.0.1', '3.1.0-beta.1') or a legacy alias (e.g. 'v3').`,
      'adcpVersion'
    );
  }
  return parsed;
}

/**
 * Returns true when the AdCP release that `bundleKey` identifies declares the
 * top-level `adcp_version` envelope field. The field landed in AdCP 3.1 per
 * spec PR `adcontextprotocol/adcp#3493` — 3.0 (any patch / prerelease) does
 * not carry it; 3.1+ does. Used to gate dual-emit on the wire so a 3.0-pinned
 * client doesn't emit a field its target schema doesn't define.
 */
export function bundleSupportsAdcpVersionField(bundleKey: string): boolean {
  const major = parseAdcpMajorVersion(bundleKey);
  if (!Number.isFinite(major)) return false;
  if (major < 3) return false;
  if (major > 3) return true;
  // Major 3 — only 3.1+ has the field. Bundle key shape is normalized by
  // `resolveBundleKey`: `'3.0'` / `'3.1'` for stable; `'3.0.0-beta.1'` /
  // `'3.1.0-beta.1'` for prereleases. Match the minor.
  const minorMatch = bundleKey.match(/^\d+\.(\d+)/);
  if (!minorMatch) return false;
  return parseInt(minorMatch[1]!, 10) >= 1;
}

/**
 * Build the wire-level version envelope to merge into outgoing request args.
 *
 * Per AdCP 3.1 (spec PR `adcontextprotocol/adcp#3493`), 3.1+ requests carry
 * BOTH the integer `adcp_major_version` (deprecated through 3.x, removed in
 * 4.0) AND the release-precision string `adcp_version`. 3.0 schemas don't
 * define the string field, so a 3.0-pinned client emits the integer only —
 * matches the 3.0 spec exactly.
 *
 * Release-precision string follows `resolveBundleKey`: `'3.0'`, `'3.1'`,
 * `'3.1.0-beta.1'` (prereleases stay verbatim — spec rule: pre-release pins
 * matched exactly).
 *
 * Returns `{}` for v2 callers (predates the major-version field entirely).
 */
function buildVersionEnvelope(
  adcpVersion: string | undefined,
  serverVersion: 'v2' | 'v3' | undefined
): Record<string, unknown> {
  if (serverVersion === 'v2') return {};
  const wireMajor = resolveWireMajor(adcpVersion);
  const bundleKey = resolveBundleKey(adcpVersion ?? ADCP_VERSION);
  if (!bundleSupportsAdcpVersionField(bundleKey)) {
    return { adcp_major_version: wireMajor };
  }
  return { adcp_major_version: wireMajor, adcp_version: bundleKey };
}

/**
 * Merge the wire-level version envelope into a caller-supplied args object.
 * Caller args win: an explicit `adcp_major_version` / `adcp_version` in
 * `args` (e.g. a conformance harness probing `VERSION_UNSUPPORTED`) passes
 * through unchanged. The envelope only fills fields the caller didn't set.
 *
 * Single chokepoint for all four wire-injection sites so a future refactor
 * can't silently flip the spread order on one branch and leave the others
 * intact. Stale dual-field drift is caught at the server boundary by
 * `createAdcpServer`'s field-disagreement check (spec PR
 * `adcontextprotocol/adcp#3493`).
 *
 * @internal
 */
export function applyVersionEnvelope(
  args: Record<string, unknown>,
  envelope: Record<string, unknown>
): Record<string, unknown> {
  return { ...envelope, ...args };
}

/**
 * Transport-level safeguards applied to a call.
 *
 * Wired into the SDK's internal fetch chain via AsyncLocalStorage, so the
 * cap takes effect even when the underlying transport's connection cache
 * reuses a fetch that was created on an earlier call with different limits.
 */
export interface TransportOptions {
  /**
   * Maximum response body size (in octets) the SDK will read before aborting
   * with `ResponseTooLargeError`. When unset, the SDK does not impose a cap —
   * matches the underlying MCP / A2A transport defaults.
   *
   * Set this when crawling **untrusted** agents (registries, federated
   * discovery layers, monitoring tools) to prevent a hostile vendor from
   * buffering a large reply before any application-layer schema validation
   * runs. Counted across response chunks; pre-cancels when `Content-Length`
   * exceeds the cap. Applies to A2A agent-card discovery
   * (`/.well-known/agent.json`) on the same call as well.
   *
   * Per-call override (`TaskOptions.transport.maxResponseBytes`) beats the
   * value set on the client constructor (`SingleAgentClientConfig.transport`).
   *
   * @remarks
   * **Leave unset for long-lived buyer sessions.** When set, the cap applies
   * to every fetch in the call's ALS scope — including any side-channel
   * `GET` the MCP transport opens for server-initiated messages. Long-lived
   * connections that legitimately stream more cumulative bytes than the cap
   * will be torn down. The option is intended for one-shot discovery / crawl
   * paths where the response is bounded by definition.
   *
   * @remarks
   * Future hardening knobs (DNS-rebind defense, scheme allow-list, request
   * timeout overrides) will land here as additional fields rather than
   * forcing callers to compose their own `fetch` — wrap order with the SDK's
   * existing signing / capture wrappers is non-obvious and a footgun.
   */
  maxResponseBytes?: number;
}

/**
 * Options for {@link ProtocolClient.callTool}. All fields are optional.
 *
 * `webhookUrl` / `webhookSecret` / `webhookToken` are for ASYNC TASK STATUS
 * notifications (push_notification_config). For reporting webhooks
 * (reporting_webhook), include them directly in `args` — they stay in skill
 * parameters and are sent verbatim to the agent.
 */
export interface CallToolOptions {
  /** Debug log array. Mutated in place by the protocol layer. */
  debugLogs?: DebugLogEntry[];
  /** URL for async task status notifications. */
  webhookUrl?: string;
  /** HMAC-SHA256 secret for push_notification_config authentication. */
  webhookSecret?: string;
  /** Bearer token for push_notification_config validation. */
  webhookToken?: string;
  /** Pinned protocol generation when the agent advertises both v2 and v3. */
  serverVersion?: 'v2' | 'v3';
  /** A2A session continuity (contextId carries conversation, taskId resumes a task). */
  session?: { contextId?: string; taskId?: string };
  /**
   * AdCP version pin from the calling client/server instance. Sets the
   * wire-level `adcp_major_version` field per-call instead of from the
   * SDK-pinned `ADCP_MAJOR_VERSION` constant. Default falls back to the
   * constant so call sites that don't plumb a per-instance version keep
   * their existing behavior. An explicit `adcp_major_version` /
   * `adcp_version` in `args` overrides this — conformance harnesses use
   * that path to probe seller version negotiation.
   */
  adcpVersion?: string;
  /**
   * Transport-level safeguards (size caps, etc.). Per-call override of any
   * matching field on the client constructor's `transport` option.
   */
  transport?: TransportOptions;
}

/**
 * Universal protocol client - automatically routes to the correct protocol implementation
 */
export class ProtocolClient {
  /**
   * Call a tool on an agent using the appropriate protocol.
   *
   * @param agent - Agent configuration
   * @param toolName - Name of the tool/skill to call
   * @param args - Tool arguments (includes reporting_webhook if needed - NOT removed)
   * @param options - Optional call-level configuration. See {@link CallToolOptions}.
   */
  static async callTool(
    agent: AgentConfig,
    toolName: string,
    args: Record<string, unknown>,
    options: CallToolOptions = {}
  ): Promise<unknown> {
    const { debugLogs = [], webhookUrl, webhookSecret, webhookToken, serverVersion, session, adcpVersion, transport } =
      options;
    // Per-instance version envelope. Throws on unparseable pins via
    // `resolveWireMajor`; construction-time `resolveAdcpVersion` is the
    // primary gate but this is the failsafe for callers reaching
    // `ProtocolClient.callTool` directly (test harnesses, the in-process
    // MCP path). Returns `{ adcp_major_version }` for 3.0 pins and
    // `{ adcp_major_version, adcp_version }` for 3.1+ pins.
    const versionEnvelope = buildVersionEnvelope(adcpVersion, serverVersion);
    // Enter the response-size-limit ALS slot once for this call. The slot is
    // read by `wrapFetchWithSizeLimit` in both protocol transports, so the
    // cap applies regardless of which path (MCP / A2A / OAuth refresh) the
    // call ends up taking. No-op when the cap is unset or non-positive.
    return withResponseSizeLimit(transport?.maxResponseBytes, () =>
      withSpan(
        `adcp.${agent.protocol}.call_tool`,
        {
          'adcp.agent_id': agent.id,
          'adcp.protocol': agent.protocol,
          'adcp.tool': toolName,
          'http.url': agent.agent_uri,
        },
        async () => {
        // In-process MCP path: pre-connected client, no HTTP transport.
        // Idempotency injection, schema validation, and governance middleware all
        // still apply (they run in SingleAgentClient above this call). We skip
        // URL validation, OAuth refresh, and signing — none apply in-process.
        if (agent.protocol === 'mcp' && agent._inProcessMcpClient) {
          const inProcArgs = applyVersionEnvelope(args, versionEnvelope);
          return callMCPToolWithClient(agent._inProcessMcpClient, toolName, inProcArgs, debugLogs);
        }

        validateAgentUrl(agent.agent_uri);

        // OAuth 2.0 client credentials (RFC 6749 §4.4): re-exchange the
        // secret for a fresh access token whenever the cached one is within
        // its expiration skew. Runs before every call so mid-session expiry
        // can't leave the caller with a stale bearer. No-op if the agent
        // doesn't declare client credentials. Cheap on warm cache (single
        // `Date.now()` compare); a single POST to the token endpoint on miss.
        //
        // `allowPrivateIp` inherits the trust the caller already placed in
        // `agent.agent_uri` — if they're making a call to a private-IP agent,
        // they've authorized this process to talk to private-IP hosts, so
        // the token endpoint on the same network is reachable too. Public
        // agent URLs with private-IP token endpoints still require an
        // explicit opt-in via the library API.
        if (agent.oauth_client_credentials) {
          const ccStorage = getAgentStorage(agent);
          const allowPrivateIp = isLikelyPrivateUrl(agent.agent_uri);
          await ensureClientCredentialsTokens(agent, { storage: ccStorage, allowPrivateIp });
        }

        const authToken = getAuthToken(agent);

        // RFC 9421 signing context. Built once per call and passed through
        // to each protocol-layer entry (`callMCPToolWithTasks`, `callA2ATool`,
        // `callMCPToolWithOAuth`) — those entries seed `signingContextStorage`
        // (AsyncLocalStorage) so the internal transport helpers read it
        // without an explicit parameter. Keep the explicit arg here: it's the
        // ALS seed, not incidental plumbing. `get_adcp_capabilities` is
        // exempt from signing (it's the discovery call itself) and also
        // triggers cache priming for any other op on agents with
        // `request_signing` configured.
        const signingContext = buildAgentSigningContext(agent);
        if (signingContext && toolName !== CAPABILITY_OP) {
          await ensureCapabilityLoaded(agent, signingContext, primeArgs =>
            ProtocolClient.callTool(agent, CAPABILITY_OP, primeArgs, {
              debugLogs,
              serverVersion,
              adcpVersion,
            })
          );
        }

        // Inject the version envelope on every request so sellers can validate
        // compatibility. Skip for v2 servers — they don't recognise the
        // version fields and strict-schema agents reject them. The envelope
        // shape is per-pin: 3.0 pins get the integer `adcp_major_version`
        // alone; 3.1+ pins get both that and the release-precision string
        // `adcp_version` (`'3.1'` / `'3.1.0-beta.1'`) per spec PR
        // `adcontextprotocol/adcp#3493`.
        const argsWithVersion = applyVersionEnvelope(args, versionEnvelope);

        // Build push_notification_config for ASYNC TASK STATUS notifications
        // (NOT for reporting_webhook - that stays in args)
        // Schema: https://adcontextprotocol.org/schemas/v1/core/push-notification-config.json
        const pushNotificationConfig: PushNotificationConfig | undefined = webhookUrl
          ? {
              url: webhookUrl,
              ...(webhookToken && { token: webhookToken }),
              authentication: {
                schemes: ['HMAC-SHA256'],
                credentials: webhookSecret || 'placeholder_secret_min_32_characters_required',
              },
            }
          : undefined;

        if (agent.protocol === 'mcp') {
          // For MCP, include push_notification_config in tool arguments (MCP spec)
          const argsWithWebhook = pushNotificationConfig
            ? { ...argsWithVersion, push_notification_config: pushNotificationConfig }
            : argsWithVersion;

          // If the agent config carries authorization-code OAuth tokens,
          // route through the OAuth provider path so the MCP SDK can refresh
          // on 401 instead of hard-failing. Excludes client-credentials
          // agents: they have a cached access token but no refresh_token,
          // and their refresh path is a secret re-exchange (handled above),
          // not the SDK's refresh_token grant.
          if (agent.oauth_tokens && !agent.oauth_client_credentials) {
            const storage = getAgentStorage(agent);
            const authProvider = createNonInteractiveOAuthProvider(agent, {
              agentHint: agent.id,
              storage,
            });
            try {
              return await callMCPToolWithOAuth({
                agentUrl: agent.agent_uri,
                toolName,
                args: argsWithWebhook,
                authProvider,
                debugLogs,
                customHeaders: agent.headers,
                signingContext,
              });
            } catch (err) {
              // Refresh failed or server rejected the refreshed token — walk the
              // discovery chain so the caller can distinguish "re-auth needed"
              // from other failure modes.
              await rethrowAsNeedsAuthorization(err, agent.agent_uri);
              throw err;
            }
          }

          // Use callMCPToolWithTasks which auto-detects server tasks capability
          // and falls back to standard callTool when tasks are not supported
          try {
            return await callMCPToolWithTasks(
              agent.agent_uri,
              toolName,
              argsWithWebhook,
              authToken,
              debugLogs,
              agent.headers,
              signingContext ? { signingContext } : undefined
            );
          } catch (err) {
            // Client-credentials agents: on 401, the AS may have rotated
            // something out-of-band. Force a fresh exchange and retry once
            // before surfacing the error. Bounded (single retry) so we don't
            // loop if the credentials are genuinely wrong.
            if (agent.oauth_client_credentials && is401Error(err)) {
              const ccStorage = getAgentStorage(agent);
              const allowPrivateIp = isLikelyPrivateUrl(agent.agent_uri);
              await ensureClientCredentialsTokens(agent, { storage: ccStorage, force: true, allowPrivateIp });
              const retryAuthToken = agent.oauth_tokens?.access_token ?? authToken;
              try {
                return await callMCPToolWithTasks(
                  agent.agent_uri,
                  toolName,
                  argsWithWebhook,
                  retryAuthToken,
                  debugLogs,
                  agent.headers,
                  signingContext ? { signingContext } : undefined
                );
              } catch (retryErr) {
                await rethrowAsNeedsAuthorization(retryErr, agent.agent_uri);
                throw retryErr;
              }
            }
            await rethrowAsNeedsAuthorization(err, agent.agent_uri);
            throw err;
          }
        } else if (agent.protocol === 'a2a') {
          // For A2A, pass pushNotificationConfig separately (not in skill parameters)
          try {
            return await callA2ATool(
              agent.agent_uri,
              toolName,
              argsWithVersion,
              authToken,
              debugLogs,
              pushNotificationConfig,
              agent.headers,
              signingContext,
              session
            );
          } catch (err) {
            // Same single-retry-on-401 for client-credentials agents as the
            // MCP path above. Kept symmetric so A2A CC agents aren't a
            // second-class experience — including the NeedsAuthorizationError
            // rewrap on a retry that still 401s.
            if (agent.oauth_client_credentials && is401Error(err)) {
              const ccStorage = getAgentStorage(agent);
              const allowPrivateIp = isLikelyPrivateUrl(agent.agent_uri);
              await ensureClientCredentialsTokens(agent, { storage: ccStorage, force: true, allowPrivateIp });
              const retryAuthToken = agent.oauth_tokens?.access_token ?? authToken;
              try {
                return await callA2ATool(
                  agent.agent_uri,
                  toolName,
                  argsWithVersion,
                  retryAuthToken,
                  debugLogs,
                  pushNotificationConfig,
                  agent.headers,
                  signingContext,
                  session
                );
              } catch (retryErr) {
                await rethrowAsNeedsAuthorization(retryErr, agent.agent_uri);
                throw retryErr;
              }
            }
            await rethrowAsNeedsAuthorization(err, agent.agent_uri);
            throw err;
          }
        } else {
          throw new Error(`Unsupported protocol: ${agent.protocol}`);
        }
      }
      )
    );
  }
}

/**
 * If `err` looks like a 401 from the MCP transport, probe the agent for a
 * Bearer challenge and throw a {@link NeedsAuthorizationError} carrying
 * walked discovery metadata. If the error isn't a 401 or we can't build a
 * requirements record, return silently so the caller re-throws the original.
 *
 * Keeping this off the hot path: we only probe on error, and the probe is
 * a single unauthenticated `tools/list` POST — no retries, no DNS rebind.
 */
async function rethrowAsNeedsAuthorization(err: unknown, agentUrl: string): Promise<void> {
  if (err instanceof NeedsAuthorizationError) throw err;
  if (!is401Error(err)) return;

  // If the caller has already connected to the agent URL, they've implicitly
  // trusted it — inherit that trust for the discovery probe so loopback /
  // private-IP development agents work the same way as public ones.
  const allowPrivateIp = isLikelyPrivateUrl(agentUrl);

  // discoverAuthorizationRequirements internally catches network failures and
  // returns null rather than throwing — anything that escapes is a genuine
  // bug we want to surface rather than mask the 401 with.
  const requirements = await discoverAuthorizationRequirements(agentUrl, { allowPrivateIp });
  if (requirements) {
    throw new NeedsAuthorizationError(requirements);
  }
  // No requirements walked; let the caller re-throw the original error.
}

/**
 * Simple factory functions for protocol-specific clients
 */
export const createMCPClient = (
  agentUrl: string,
  authToken?: string,
  headers?: Record<string, string>,
  serverVersion?: 'v2' | 'v3',
  adcpVersion?: string
) => {
  // Validate the pin at factory time so a typo surfaces here rather than at
  // first call. `buildVersionEnvelope` throws via `resolveWireMajor` on bad
  // input — call it once to surface, then close over the envelope.
  const versionEnvelope = buildVersionEnvelope(adcpVersion, serverVersion);
  return {
    callTool: (toolName: string, args: Record<string, unknown>, debugLogs?: DebugLogEntry[]) =>
      callMCPToolWithTasks(
        agentUrl,
        toolName,
        applyVersionEnvelope(args, versionEnvelope),
        authToken,
        debugLogs,
        headers
      ),
  };
};

export const createA2AClient = (
  agentUrl: string,
  authToken?: string,
  headers?: Record<string, string>,
  serverVersion?: 'v2' | 'v3',
  adcpVersion?: string
) => {
  const versionEnvelope = buildVersionEnvelope(adcpVersion, serverVersion);
  return {
    callTool: (toolName: string, parameters: Record<string, unknown>, debugLogs?: DebugLogEntry[]) =>
      callA2ATool(
        agentUrl,
        toolName,
        applyVersionEnvelope(parameters, versionEnvelope),
        authToken,
        debugLogs,
        undefined,
        headers
      ),
  };
};
