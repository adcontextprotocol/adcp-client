/**
 * `runAgainstLocalAgent` — one-call compliance harness for server-side
 * AdCP agents.
 *
 * The 300-line "spin up my Express-equivalent, seed fixtures, create a
 * webhook receiver, loop through storyboards, aggregate results" loop
 * sellers keep hand-rolling collapses into:
 *
 * ```ts
 * const result = await runAgainstLocalAgent({
 *   createAgent: () => createAdcpServer({ ...myHandlers, stateStore }),
 *   capabilities: { supported_protocols: ['media-buy'], specialisms: ['sales-non-guaranteed'] },
 * });
 * ```
 *
 * What it composes:
 *   - {@link serve} on an ephemeral port (real HTTP transport — MCP
 *     wire-format bugs surface, unlike in-memory dispatch)
 *   - {@link seedComplianceFixtures} against the `AdcpServer` (skipped
 *     when the caller returns a raw `McpServer`)
 *   - Optional `createTestAuthorizationServer` for closed-loop OAuth
 *   - {@link runStoryboard} per applicable storyboard, with
 *     `webhook_receiver: { mode: 'loopback_mock' }` wired by default so
 *     the webhook-emission universal grades instead of skipping
 *
 * The caller's `createAgent` factory MUST close over a stable
 * `stateStore` so fixtures seeded once persist across requests. The
 * `serve()` contract calls the factory once per request — every call
 * needs to see the same store.
 *
 * What this helper does NOT do:
 *   - Start tunnels (use the CLI's `--webhook-receiver-auto-tunnel` when
 *     fronting a remote agent instead)
 *   - Mint tokens per-storyboard automatically — call
 *     `authorizationServer.issueToken()` in `onListening` and stash the
 *     result on `runStoryboardOptions.auth` when a flow needs one
 */

import { createServer as createNetProbe, type AddressInfo } from 'node:net';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Server as HttpServer } from 'node:http';
import type { AdcpServer } from '../server/adcp-server';
import { ADCP_STATE_STORE } from '../server/adcp-server';
import { serve, type ServeContext, type ServeOptions, type ProtectedResourceMetadata } from '../server/serve';
import { seedComplianceFixtures, type SeedComplianceFixturesOptions } from '../compliance-fixtures';
import {
  createTestAuthorizationServer,
  type TestAuthorizationServer,
  type TestAuthorizationServerOptions,
} from '../compliance-fixtures/test-authorization-server';
import {
  listAllComplianceStoryboards,
  resolveBundleOrStoryboard,
  resolveStoryboardsForCapabilities,
  type AgentCapabilities,
  type ResolveOptions,
} from './storyboard/compliance';
import { runStoryboard } from './storyboard/runner';
import type { Storyboard, StoryboardResult, StoryboardRunOptions } from './storyboard/types';

export interface RunAgainstLocalAgentOptions {
  /**
   * Factory matching {@link serve}'s contract. Receives a {@link ServeContext}
   * with a shared `taskStore` and returns either an `AdcpServer` or a raw
   * `McpServer`. Called once per HTTP request plus once ahead of time by
   * the helper to seed fixtures — the factory MUST close over a stable
   * `stateStore` so every call sees the same data.
   */
  createAgent: (ctx: ServeContext) => AdcpServer | McpServer;

  /**
   * Which storyboards to run:
   *   - `'all'` (default): every storyboard in the compliance cache
   *   - `AgentCapabilities`: capability-driven resolution (the same
   *     predicate the live assessment runner uses on an agent's own
   *     `get_adcp_capabilities` response)
   *   - `string[]`: storyboard or bundle ids
   *   - `Storyboard[]`: already-loaded storyboards
   */
  storyboards?: 'all' | AgentCapabilities | string[] | Storyboard[];

  /**
   * Seed {@link COMPLIANCE_FIXTURES} into the `AdcpServer`'s state store
   * before the first storyboard. Defaults to `true` when `createAgent`
   * returns an `AdcpServer`; ignored when it returns a raw `McpServer`.
   *
   * Pass an options object to customize categories / overrides.
   */
  fixtures?: boolean | SeedComplianceFixturesOptions;

  /**
   * Host a loopback webhook receiver per storyboard so `expect_webhook*`
   * steps grade instead of skipping. Defaults to `true`. Set `false` to
   * skip, or supply a partial config to override defaults.
   */
  webhookReceiver?: boolean | StoryboardRunOptions['webhook_receiver'];

  /**
   * Stand up a test authorization server and advertise it via RFC 9728
   * protected-resource metadata on the agent. Defaults to `false` — most
   * sellers don't need OAuth in local loops. When enabled:
   *
   *   - Starts a {@link createTestAuthorizationServer}
   *   - Passes `protectedResource: { authorization_servers: [AS.issuer] }`
   *     and `publicUrl` to `serve()`
   *   - Exposes `auth` on the `onListening` hook so callers can mint tokens
   */
  authorizationServer?: boolean | TestAuthorizationServerOptions;

  /**
   * Extra options forwarded to {@link serve}. `port`, `onListening`,
   * `publicUrl`, `taskStore`, and `protectedResource` are managed by the
   * helper and values passed here are ignored.
   */
  serveOptions?: Omit<ServeOptions, 'port' | 'onListening' | 'publicUrl' | 'protectedResource' | 'taskStore'>;

  /**
   * Forwarded to every `runStoryboard` call. `webhook_receiver` is set by
   * the helper — use `webhookReceiver` at the top level to override.
   *
   * `allow_http` defaults to `true` when the helper is running against its
   * own ephemeral `http://127.0.0.1:<port>/mcp` URL — the storyboard
   * runner's SSRF guard would otherwise refuse to probe the in-process
   * agent it just stood up. Pass `allow_http: false` here if you redirect
   * storyboards to an external `https://` agent via
   * `resolvePerStoryboard` and want loopback-protection back.
   */
  runStoryboardOptions?: Omit<StoryboardRunOptions, 'webhook_receiver'>;

  /**
   * Produce per-storyboard overrides, called once per storyboard right
   * before `runStoryboard`. Return `undefined` (or an empty object) to use
   * the defaults; otherwise:
   *
   *   - `agentUrl` — redirect this storyboard to a different URL than the
   *     ephemeral `http://127.0.0.1:<port>/mcp` the helper bound. Useful
   *     when one storyboard needs to hit a stricter sibling route (e.g.
   *     `/mcp-strict` for the `signed_requests` storyboard) while the rest
   *     stay on the sandbox mount.
   *   - every other `StoryboardRunOptions` field is shallow-merged on top
   *     of the run-level `runStoryboardOptions`. Common uses: per-
   *     storyboard `test_kit`, `brand`, or `contracts` that vary with the
   *     storyboard under test. `webhook_receiver` is owned by the helper's
   *     `webhookReceiver` field and is typed out of the override shape —
   *     the helper re-applies it after the merge so overrides can't stomp
   *     the loopback mock.
   *
   * Returning a `Promise` is supported so callers can do async work per
   * storyboard (load a test-kit YAML, mint a scoped token, fetch brand
   * metadata). The helper awaits before issuing `runStoryboard`.
   */
  resolvePerStoryboard?: (
    storyboard: Storyboard,
    defaultAgentUrl: string
  ) => PerStoryboardOverride | undefined | Promise<PerStoryboardOverride | undefined>;

  /** Compliance cache overrides. */
  compliance?: ResolveOptions;

  /**
   * Streaming callback fired after each storyboard completes. Useful for
   * CLI progress output so implementors don't wait for the full aggregate.
   */
  onStoryboardComplete?: (result: StoryboardResult, index: number, total: number) => void;

  /**
   * Called once the agent is bound and fixtures are seeded. Receives the
   * canonical agent URL plus (when enabled) the AS handle. Use it to mint
   * tokens and stash them on `runStoryboardOptions.auth`, or to seed
   * non-fixture state.
   */
  onListening?: (info: { agentUrl: string; auth?: TestAuthorizationServer }) => void | Promise<void>;

  /**
   * Stop after the first failing storyboard. Defaults to `false` — the
   * helper runs every storyboard so every failure site is visible.
   */
  bail?: boolean;
}

/**
 * Per-storyboard override returned by {@link RunAgainstLocalAgentOptions.resolvePerStoryboard}.
 *
 * `agentUrl` redirects the storyboard to a different URL. Every other
 * `StoryboardRunOptions` field is shallow-merged on top of the run-level
 * defaults. `webhook_receiver` is intentionally omitted — the helper owns
 * that field via its `webhookReceiver` option and re-applies it after the
 * merge.
 */
export type PerStoryboardOverride = { agentUrl?: string } & Omit<Partial<StoryboardRunOptions>, 'webhook_receiver'>;

export interface LocalAgentRunResult {
  /** True iff every storyboard passed (steps + assertions). */
  overall_passed: boolean;
  /** Canonical URL the helper mounted the agent at. */
  agent_url: string;
  /** Per-storyboard results, in run order. */
  results: StoryboardResult[];
  /** Storyboards skipped because the agent's capabilities place them out of scope. */
  not_applicable: Array<{ storyboard_id: string; storyboard_title: string; reason: string }>;
  /** Sum across all run storyboards. */
  passed_count: number;
  failed_count: number;
  skipped_count: number;
  total_duration_ms: number;
}

/**
 * True when `url` is an http:// (not https://) URL pointing at a loopback
 * host — used to decide whether the SSRF guard's HTTPS-only default can be
 * relaxed. Must be tight: a `http://` prefix alone is NOT sufficient (a
 * caller override could redirect to `http://attacker.example.com/mcp` and
 * inherit the allowance). Only `127.0.0.1`, `::1`, and `localhost` count.
 *
 * @internal
 */
function isLoopbackHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') return false;
    // `URL.hostname` wraps IPv6 literals in brackets (`[::1]`); strip them
    // to match the bare forms typical in SSRF loopback checks.
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === '127.0.0.1' || host === '::1' || host === 'localhost';
  } catch {
    return false;
  }
}

/**
 * Run storyboards against an in-process AdCP agent. Handles lifecycle:
 * bind, seed, (optional) token issuance, loop, tear down.
 */
export async function runAgainstLocalAgent(options: RunAgainstLocalAgentOptions): Promise<LocalAgentRunResult> {
  const startedAt = Date.now();
  const mountPath = options.serveOptions?.path ?? '/mcp';
  const taskStore: TaskStore = new InMemoryTaskStore();
  const ctx: ServeContext = { taskStore };

  let auth: TestAuthorizationServer | undefined;
  let httpServer: HttpServer | undefined;

  try {
    if (options.authorizationServer) {
      const authOptions = typeof options.authorizationServer === 'object' ? options.authorizationServer : {};
      auth = await createTestAuthorizationServer(authOptions);
    }

    // Bootstrap: call the factory once ahead of time to get an AdcpServer
    // we can seed against. serve() will call the factory again for every
    // real request — the user's stateStore closure guarantees seeds persist.
    const bootstrapAgent = options.createAgent(ctx);
    const bootstrapIsAdcp = isAdcpServer(bootstrapAgent);
    if (bootstrapIsAdcp && options.fixtures !== false) {
      const seedOptions = typeof options.fixtures === 'object' ? options.fixtures : {};
      await seedComplianceFixtures(bootstrapAgent, seedOptions);
    }
    // Release the bootstrap instance so serve()'s per-request factory calls
    // produce fresh servers. Closing is idempotent.
    await bootstrapAgent.close();

    // serve() validates publicUrl path against mountPath synchronously, so
    // we need the port known before the call. Grab a free port first.
    const port = await allocatePort();
    const publicUrl = `http://127.0.0.1:${port}${mountPath}`;
    const agentUrl = publicUrl;

    const protectedResource: ProtectedResourceMetadata | undefined = auth
      ? { authorization_servers: [auth.issuer] }
      : undefined;

    httpServer = serve(options.createAgent, {
      ...options.serveOptions,
      taskStore,
      port,
      ...(protectedResource ? { protectedResource, publicUrl } : {}),
      onListening: () => {
        /* swallow the default console.log — callers can observe via onListening */
      },
    });

    await waitForListening(httpServer);

    if (options.onListening) {
      await options.onListening({ agentUrl, auth });
    }

    const toRun = await resolveStoryboardSet(options);
    const results: StoryboardResult[] = [];
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    const webhookConfig = resolveWebhookReceiver(options.webhookReceiver);
    const explicitAllowHttp = options.runStoryboardOptions?.allow_http;
    const baseRunOptions: Omit<StoryboardRunOptions, 'webhook_receiver' | 'allow_http'> = {
      ...(options.runStoryboardOptions ?? {}),
    };
    // `allow_http` is removed from baseRunOptions and recomputed per
    // storyboard below — inheriting `true` across storyboards would let a
    // `resolvePerStoryboard` override that redirected to a remote
    // `http://...` URL bypass the SSRF guard and silently probe an
    // attacker-controlled target with private-IP allowance.
    delete (baseRunOptions as { allow_http?: unknown }).allow_http;

    for (let i = 0; i < toRun.storyboards.length; i++) {
      const sb = toRun.storyboards[i]!;
      const override = (await options.resolvePerStoryboard?.(sb, agentUrl)) ?? undefined;
      const { agentUrl: overrideUrl, ...overrideRunOptions } = override ?? {};
      const storyboardUrl = overrideUrl ?? agentUrl;
      // Tighten the SSRF-guard bypass: only auto-opt-in `allow_http` when
      // THIS storyboard's URL is loopback-bound (what the helper owns).
      // An override to `http://attacker.example.com/...` must not
      // inherit the default — that would re-enable the private-IP
      // allowance against attacker-controlled infrastructure.
      const storyboardIsLoopbackHttp = isLoopbackHttpUrl(storyboardUrl);
      const effectiveAllowHttp =
        (overrideRunOptions as { allow_http?: boolean }).allow_http ?? explicitAllowHttp ?? storyboardIsLoopbackHttp;
      // webhook_receiver is helper-owned — re-applied after the merge so
      // overrides can't replace the loopback mock the helper promised.
      const storyboardOptions: StoryboardRunOptions = {
        ...baseRunOptions,
        ...overrideRunOptions,
        allow_http: effectiveAllowHttp,
        ...(webhookConfig ? { webhook_receiver: webhookConfig } : {}),
      };
      const result = await runStoryboard(storyboardUrl, sb, storyboardOptions);
      results.push(result);
      passed += result.passed_count;
      failed += result.failed_count;
      skipped += result.skipped_count;
      if (options.onStoryboardComplete) {
        options.onStoryboardComplete(result, i, toRun.storyboards.length);
      }
      if (options.bail && !result.overall_passed) break;
    }

    return {
      overall_passed: results.every(r => r.overall_passed),
      agent_url: agentUrl,
      results,
      not_applicable: toRun.not_applicable,
      passed_count: passed,
      failed_count: failed,
      skipped_count: skipped,
      total_duration_ms: Date.now() - startedAt,
    };
  } finally {
    await closeHttpServer(httpServer);
    if (auth) await auth.close();
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function isAdcpServer(candidate: unknown): candidate is AdcpServer {
  if (candidate == null || typeof candidate !== 'object') return false;
  return typeof (candidate as Record<symbol, unknown>)[ADCP_STATE_STORE] === 'object';
}

function resolveWebhookReceiver(
  option: RunAgainstLocalAgentOptions['webhookReceiver']
): StoryboardRunOptions['webhook_receiver'] | undefined {
  if (option === false) return undefined;
  if (option === true || option === undefined) return { mode: 'loopback_mock' };
  return option;
}

async function resolveStoryboardSet(options: RunAgainstLocalAgentOptions): Promise<{
  storyboards: Storyboard[];
  not_applicable: Array<{ storyboard_id: string; storyboard_title: string; reason: string }>;
}> {
  const spec = options.storyboards ?? 'all';
  const compliance = options.compliance ?? {};
  if (spec === 'all') {
    return { storyboards: listAllComplianceStoryboards(compliance), not_applicable: [] };
  }
  if (Array.isArray(spec)) {
    if (spec.length === 0) return { storyboards: [], not_applicable: [] };
    if (typeof spec[0] === 'object' && 'phases' in (spec[0] as Storyboard)) {
      return { storyboards: spec as Storyboard[], not_applicable: [] };
    }
    const resolved: Storyboard[] = [];
    const unknown: string[] = [];
    for (const id of spec as string[]) {
      const matches = resolveBundleOrStoryboard(id, compliance);
      if (matches.length === 0) {
        unknown.push(id);
      } else {
        resolved.push(...matches);
      }
    }
    if (unknown.length > 0) {
      throw new Error(
        `runAgainstLocalAgent: unknown storyboard or bundle id(s): ${unknown.join(', ')}. ` +
          `Run \`adcp storyboard list\` to see available ids.`
      );
    }
    const seen = new Set<string>();
    return {
      storyboards: resolved.filter(sb => (seen.has(sb.id) ? false : (seen.add(sb.id), true))),
      not_applicable: [],
    };
  }
  const resolved = resolveStoryboardsForCapabilities(spec, compliance);
  return {
    storyboards: resolved.storyboards,
    not_applicable: resolved.not_applicable.map(n => ({
      storyboard_id: n.storyboard_id,
      storyboard_title: n.storyboard_title,
      reason: n.reason,
    })),
  };
}

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetProbe();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

function waitForListening(server: HttpServer): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      server.off('listening', onListening);
      server.off('error', onError);
    };
    server.on('listening', onListening);
    server.on('error', onError);
  });
}

function closeHttpServer(server: HttpServer | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.closeAllConnections?.();
    server.close(err => {
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
      else resolve();
    });
  });
}
