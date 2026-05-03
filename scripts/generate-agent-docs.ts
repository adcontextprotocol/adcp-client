#!/usr/bin/env tsx

/**
 * Generates docs/llms.txt and docs/TYPE-SUMMARY.md from the AdCP schema index.
 *
 * These files give AI agents a single-fetch overview of the protocol without
 * reading the 13k+ line generated type files.
 *
 * Run: tsx scripts/generate-agent-docs.ts
 * CI:  npm run ci:docs-check
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..');
const SCHEMA_CACHE_DIR = path.join(ROOT, 'schemas/cache/latest');
const INDEX_PATH = path.join(SCHEMA_CACHE_DIR, 'index.json');
const LLMS_TXT_PATH = path.join(ROOT, 'docs/llms.txt');
const TYPE_SUMMARY_PATH = path.join(ROOT, 'docs/TYPE-SUMMARY.md');
const MANIFEST_PATH = path.join(SCHEMA_CACHE_DIR, 'manifest.json');
const COMPLIANCE_CACHE_DIR = path.join(ROOT, 'compliance/cache/latest');
const CLI_PATH = path.join(ROOT, 'bin/adcp.js');

// Domains whose `tasks` we emit as tools (order matters for output)
const TOOL_DOMAINS = [
  'protocol',
  'account',
  'media-buy',
  'creative',
  'signals',
  'governance',
  'sponsored-intelligence',
] as const;

// Domains with `operations` instead of `tasks` (different key in index.json)
const OPERATION_DOMAINS = ['trusted-match'] as const;

// Skip internal/sandbox-only tools
const SKIP_TOOLS = new Set(['comply-test-controller']);

// Short, high-signal "watch out" notes appended below the Response block for
// specific tools. Kept here so regenerating llms.txt from the schema index
// still carries the operational lessons that bit real integrators.
// Keep each entry under ~5 lines — llms.txt is a scan surface, not a tutorial.
const TOOL_GOTCHAS: Record<string, string[]> = {
  build_creative: [
    'Response is ALWAYS `{ creative_manifest }` (single) or `{ creative_manifests }` (multi). Platform-native fields at the top level (`tag_url`, `creative_id`, `media_type`) are invalid.',
    'Use `buildCreativeResponse({ creative_manifest })` / `buildCreativeMultiResponse({ creative_manifests })` from `@adcp/sdk/server` to enforce the shape at compile time.',
    'Each asset under `creative_manifest.assets` needs an `asset_type` discriminator — use the factories: `imageAsset`, `videoAsset`, `audioAsset`, `htmlAsset`, `urlAsset`, `textAsset` (or `Asset.image(...)`).',
  ],
  preview_creative: [
    'Each `renders[]` entry is a oneOf on `output_format` — use `urlRender({...})`, `htmlRender({...})`, or `bothRender({...})` to inject the discriminator and require the matching `preview_url`/`preview_html` field.',
  ],
  list_creative_formats: [
    'Each `renders[]` entry satisfies a `oneOf` — exactly one of `dimensions` (object) OR `parameters_from_format_id: true`. A render with only `{ role }` (or `{ role, duration_seconds }`) fails validation.',
    'Use the typed factories from `@adcp/sdk`: `displayRender({ role, dimensions })` for display/video; `parameterizedRender({ role })` for audio and template formats (auto-injects `parameters_from_format_id: true`).',
    'Audio formats (`type: "audio"`) have no width/height — declare `renders: [parameterizedRender({ role: "primary" })]` and encode duration/codec in `format_id.parameters` (declared via `accepts_parameters`).',
  ],
};

// GitHub Pages base URL for published docs
const DOCS_BASE_URL = 'https://adcontextprotocol.github.io/adcp-client';

// Storyboard filenames that aren't runnable flows (schema defs, fixture bundles)
const SKIP_STORYBOARDS = new Set(['storyboard-schema.yaml', 'fictional-entities.yaml', 'schema_validation.yaml']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SchemaIndex {
  adcp_version: string;
  lastUpdated: string;
  schemas: Record<string, any>;
}

interface ToolInfo {
  name: string; // snake_case MCP tool name
  kebab: string; // kebab-case key in index.json
  domain: string;
  reqDescription: string;
  resDescription: string;
  requiredFields: string[];
  optionalFields: string[];
  resRequiredFields: string[];
  resOptionalFields: string[];
}

function loadIndex(): SchemaIndex {
  if (!existsSync(INDEX_PATH)) {
    console.error(`Schema index not found at ${INDEX_PATH}. Run: npm run sync-schemas`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
}

function loadSchema(ref: string): any {
  // Strip /schemas/{version}/ prefix to get relative path
  let rel = ref;
  if (rel.startsWith('/schemas/')) {
    rel = rel.substring('/schemas/'.length);
    const segments = rel.split('/');
    if (segments[0].match(/^(v\d+|\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?|latest)$/)) {
      rel = segments.slice(1).join('/');
    }
  }
  const filePath = path.join(SCHEMA_CACHE_DIR, rel);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function kebabToSnake(s: string): string {
  return s.replace(/-/g, '_');
}

function kebabToTitle(s: string): string {
  return s
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function summarizeFields(schema: any): { required: string[]; optional: string[] } {
  if (!schema?.properties) return { required: [], optional: [] };
  const req = new Set(schema.required || []);
  const required: string[] = [];
  const optional: string[] = [];

  for (const [name, prop] of Object.entries<any>(schema.properties)) {
    // Skip protocol-level fields that appear on every request
    if (name === 'adcp_major_version' || name === 'ext') continue;

    const typeHint = fieldType(prop);
    const entry = typeHint ? `${name}: ${typeHint}` : name;

    if (req.has(name)) {
      required.push(entry);
    } else {
      optional.push(entry);
    }
  }
  return { required, optional };
}

/**
 * Summarize response fields. Response schemas often have a `oneOf` discriminator
 * (success / error variants); we prefer the first branch that looks like
 * "success" (no `errors` required) to document the happy-path shape. Error
 * shapes are uniform across tools and don't need per-tool documentation.
 */
function summarizeResponseFields(schema: any): { required: string[]; optional: string[] } {
  if (!schema) return { required: [], optional: [] };

  // oneOf / anyOf — pick the success branch (doesn't require `errors`)
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const successBranch = schema.oneOf.find((b: any) => !(b.required || []).includes('errors')) ?? schema.oneOf[0];
    return summarizeFields(successBranch);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const successBranch = schema.anyOf.find((b: any) => !(b.required || []).includes('errors')) ?? schema.anyOf[0];
    return summarizeFields(successBranch);
  }
  return summarizeFields(schema);
}

function fieldType(prop: any): string {
  if (!prop) return '';
  if (prop.enum) return prop.enum.map((v: string) => `'${v}'`).join(' | ');
  if (prop.const) return `'${prop.const}'`;
  if (prop.type === 'array') {
    const itemType = prop.items?.title || prop.items?.type || 'object';
    return `${itemType}[]`;
  }
  if (prop.type === 'object' && prop.title) return prop.title;
  if (prop.$ref) {
    // Extract type name from $ref path
    const parts = prop.$ref.split('/');
    const filename = parts[parts.length - 1].replace('.json', '');
    return kebabToTitle(filename);
  }
  if (prop.oneOf || prop.anyOf) {
    const variants = prop.oneOf || prop.anyOf;
    if (variants.length <= 3) {
      return variants
        .map((v: any) => v.title || v.const || fieldType(v))
        .filter(Boolean)
        .join(' | ');
    }
    return 'union';
  }
  if (prop.type) return prop.type;
  return '';
}

/** Collect all tools from domains that use `tasks`. */
function collectTools(index: SchemaIndex): ToolInfo[] {
  const tools: ToolInfo[] = [];

  for (const domain of TOOL_DOMAINS) {
    const domainEntry = index.schemas[domain];
    if (!domainEntry?.tasks) continue;

    for (const [kebab, task] of Object.entries<any>(domainEntry.tasks)) {
      if (SKIP_TOOLS.has(kebab)) continue;

      const reqSchema = task.request?.$ref ? loadSchema(task.request.$ref) : null;
      const resSchema = task.response?.$ref ? loadSchema(task.response.$ref) : null;
      const { required, optional } = summarizeFields(reqSchema);
      const resFields = summarizeResponseFields(resSchema);

      tools.push({
        name: kebabToSnake(kebab),
        kebab,
        domain,
        reqDescription: task.request?.description || reqSchema?.description || '',
        resDescription: task.response?.description || resSchema?.description || '',
        requiredFields: required,
        optionalFields: optional,
        resRequiredFields: resFields.required,
        resOptionalFields: resFields.optional,
      });
    }
  }
  return tools;
}

/** Group tools by domain. */
function groupByDomain(tools: ToolInfo[]): Map<string, ToolInfo[]> {
  const map = new Map<string, ToolInfo[]>();
  for (const t of tools) {
    if (!map.has(t.domain)) map.set(t.domain, []);
    map.get(t.domain)!.push(t);
  }
  return map;
}

function domainLabel(domain: string): string {
  const labels: Record<string, string> = {
    protocol: 'Protocol',
    account: 'Account Management',
    'media-buy': 'Media Buying',
    creative: 'Creative',
    signals: 'Signals',
    governance: 'Governance',
    'sponsored-intelligence': 'Sponsored Intelligence',
    'trusted-match': 'Trusted Match (TMP)',
  };
  return labels[domain] || kebabToTitle(domain);
}

function trackLabel(track: string): string {
  const overrides: Record<string, string> = {
    si: 'Sponsored Intelligence (SI)',
    campaign_governance: 'Campaign Governance',
    error_handling: 'Error Handling',
    media_buy: 'Media Buy',
  };
  return overrides[track] || kebabToTitle(track.replace(/_/g, ' '));
}

/** Per-domain pointers to deeper documentation. */
function domainDeepDives(domain: string): string[] {
  const links: Record<string, string[]> = {
    'media-buy': [
      'docs/getting-started.md — installation, auth, basic usage',
      'docs/guides/ASYNC-DEVELOPER-GUIDE.md — async task patterns (submitted, deferred, input-required)',
      'docs/guides/PUSH-NOTIFICATION-CONFIG.md — webhook setup for delivery reports',
      'docs/guides/REAL-WORLD-EXAMPLES.md — end-to-end buying flows',
    ],
    creative: [
      'docs/guides/BUILD-AN-AGENT.md — building a creative agent (server-side)',
      'schemas/cache/latest/creative/asset-types/index.json — asset type definitions',
    ],
    signals: ['docs/guides/BUILD-AN-AGENT.md — signals agent example'],
    governance: ['docs/guides/HANDLER-PATTERNS-GUIDE.md — input handler patterns for governance flows'],
    'sponsored-intelligence': ['docs/guides/ASYNC-DEVELOPER-GUIDE.md — session lifecycle patterns'],
    account: ['docs/getting-started.md — authentication and account setup'],
  };
  return links[domain] || [];
}

// ---------------------------------------------------------------------------
// Error code parser (reads TypeScript source directly)
// ---------------------------------------------------------------------------

interface ErrorCodeEntry {
  code: string;
  description: string;
  recovery: 'transient' | 'correctable' | 'terminal';
}

function parseErrorCodes(): ErrorCodeEntry[] {
  // AdCP 3.0.4 (adcp#3738) ships a `manifest.json` that's the canonical
  // source for error codes. Sourcing here matches `STANDARD_ERROR_CODES` —
  // both derive from the same artifact, so docs and runtime stay aligned.
  if (!existsSync(MANIFEST_PATH)) return [];
  let manifest: { error_codes?: Record<string, { description?: string; recovery?: string }> };
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (err) {
    // Surface a parse failure rather than silently emitting docs without an
    // error-code section. CI's agent-docs-in-sync check will catch the empty
    // section, but the warning aids debugging when running locally.
    console.warn(
      `⚠️  Failed to parse ${MANIFEST_PATH}: ${(err as Error).message}. ` +
        `Error-code section will be empty. Re-run \`npm run sync-schemas\` to refresh the cache.`
    );
    return [];
  }
  const codes = manifest.error_codes;
  if (!codes) return [];
  return Object.entries(codes)
    .map(([code, info]) => ({
      code,
      description: info?.description ?? '',
      recovery: (info?.recovery as ErrorCodeEntry['recovery']) ?? 'transient',
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------------------
// Storyboard parser (lightweight YAML field extraction — no yaml dependency)
// ---------------------------------------------------------------------------

interface StoryboardSummary {
  id: string;
  title: string;
  summary: string;
  track: string;
  requiredTools: string[];
  flow: string; // compact tool sequence
}

function parseStoryboards(): StoryboardSummary[] {
  if (!existsSync(COMPLIANCE_CACHE_DIR)) return [];

  // Walk universal/, protocols/{id}/index.yaml, protocols/{id}/scenarios/*, and
  // specialisms/{id}/index.yaml (+ any other top-level YAMLs in the specialism dir).
  const files: string[] = [];
  const collect = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (SKIP_STORYBOARDS.has(entry)) continue;
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        collect(full);
      } else if (entry.endsWith('.yaml')) {
        files.push(full);
      }
    }
  };
  collect(path.join(COMPLIANCE_CACHE_DIR, 'universal'));
  collect(path.join(COMPLIANCE_CACHE_DIR, 'protocols'));
  collect(path.join(COMPLIANCE_CACHE_DIR, 'specialisms'));

  return files
    .sort()
    .map(full => {
      const content = readFileSync(full, 'utf8');
      const id = yamlField(content, 'id');
      if (!id) return null;
      return {
        id,
        title: yamlField(content, 'title') || '',
        summary: yamlField(content, 'summary') || '',
        track: yamlField(content, 'track') || '',
        requiredTools: yamlListField(content, 'required_tools'),
        flow: extractToolFlow(content),
      };
    })
    .filter((s): s is StoryboardSummary => s !== null && !!s.title);
}

/** Extract a top-level scalar YAML field (single line). */
function yamlField(content: string, field: string): string {
  const re = new RegExp(`^${field}:\\s*(?:"([^"]+)"|'([^']+)'|(.+))`, 'm');
  const m = content.match(re);
  if (!m) return '';
  return (m[1] || m[2] || m[3] || '').trim();
}

/** Extract a top-level YAML list field. */
function yamlListField(content: string, field: string): string[] {
  const re = new RegExp(`^${field}:\\s*\\n((?:  - .+\\n?)*)`, 'm');
  const m = content.match(re);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map(l => l.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
}

/** Extract ordered tool names from storyboard step `task:` fields. */
// Synthetic tasks the runner executes itself (well-known metadata fetches,
// accumulated-flag assertions) — not agent-implemented protocol tools. Omit
// from the per-storyboard Flow summary so LLMs don't mistake them for tools
// an agent must expose.
const RUNNER_INTERNAL_TASKS: ReadonlySet<string> = new Set([
  'protected_resource_metadata',
  'oauth_auth_server_metadata',
  'assert_contribution',
]);

function extractToolFlow(content: string): string {
  const tools: string[] = [];
  const re = /^\s+task:\s*(\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const tool = m[1];
    if (RUNNER_INTERNAL_TASKS.has(tool)) continue;
    // Deduplicate consecutive same-tool calls
    if (tools[tools.length - 1] !== tool) {
      tools.push(tool);
    }
  }
  return tools.join(' → ');
}

// ---------------------------------------------------------------------------
// Test scenario parser (reads CLI source)
// ---------------------------------------------------------------------------

interface TestScenario {
  name: string;
  description: string;
}

function parseTestScenarios(): TestScenario[] {
  if (!existsSync(CLI_PATH)) return [];
  const src = readFileSync(CLI_PATH, 'utf8');

  // Extract scenario names from the TEST_SCENARIOS array
  const arrayMatch = src.match(/const TEST_SCENARIOS\s*=\s*\[([\s\S]*?)\];/);
  if (!arrayMatch) return [];
  const names = arrayMatch[1].match(/'(\w+)'/g)?.map(s => s.replace(/'/g, '')) || [];

  // Extract descriptions from the descriptions object
  const descMatch = src.match(/const descriptions\s*=\s*\{([\s\S]*?)\};/);
  const descs: Record<string, string> = {};
  if (descMatch) {
    const re = /(\w+):\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(descMatch[1])) !== null) {
      descs[m[1]] = m[2];
    }
  }

  return names.map(name => ({
    name,
    description: descs[name] || '',
  }));
}

// Read library version from version.ts (avoid importing TS)
function getLibraryVersion(): string {
  const versionFile = readFileSync(path.join(ROOT, 'src/lib/version.ts'), 'utf8');
  const match = versionFile.match(/LIBRARY_VERSION\s*=\s*'([^']+)'/);
  return match?.[1] || 'unknown';
}

// ---------------------------------------------------------------------------
// Content-aware write (ignores timestamp line for diff)
// ---------------------------------------------------------------------------

function writeIfChanged(filePath: string, content: string): boolean {
  const strip = (s: string) => s.replace(/^> Generated at: .+$/m, '');
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf8');
    if (strip(existing) === strip(content)) return false;
  }
  writeFileSync(filePath, content);
  return true;
}

// ---------------------------------------------------------------------------
// llms.txt generator
// ---------------------------------------------------------------------------

function generateLlmsTxt(
  index: SchemaIndex,
  tools: ToolInfo[],
  errorCodes: ErrorCodeEntry[],
  storyboards: StoryboardSummary[],
  scenarios: TestScenario[]
): string {
  const groups = groupByDomain(tools);
  const version = getLibraryVersion();
  const now = new Date().toISOString().split('T')[0];

  const lines: string[] = [];
  const ln = (s = '') => lines.push(s);

  // --- Header ---
  ln(`# Ad Context Protocol (AdCP)`);
  ln();
  ln(`> Generated at: ${now}`);
  ln(`> Library: @adcp/sdk v${version}`);
  ln(`> AdCP major version: 3`);
  ln(`> Canonical URL: ${DOCS_BASE_URL}/llms.txt`);
  ln();
  ln(`## What is AdCP`);
  ln();
  ln(
    `AdCP is an open protocol for AI agents to buy, manage, and optimize advertising programmatically. It defines MCP tools that agents call on publisher ad servers — discover inventory, create media buys, sync creatives, manage brand safety, and track delivery. Every tool follows request/response JSON schemas; the TypeScript client wraps them with async task handling, conversation context, and governance middleware.`
  );
  ln();

  // --- Client vs. server routing ---
  ln(`## Are you building a client or a server?`);
  ln();
  ln(`- **Client** (calling existing agents): Continue reading — the Quick Start below is for you.`);
  ln(
    `- **Server** (implementing an agent that others call): Read \`docs/guides/BUILD-AN-AGENT.md\` and \`docs/migration-5.x-to-6.x.md\`. v6 recommended path:`
  );
  ln();
  ln('```typescript');
  ln(`import { serve } from '@adcp/sdk';`);
  ln(`import { createAdcpServerFromPlatform } from '@adcp/sdk/server';`);
  ln();
  ln(`const platform = {`);
  ln(`  capabilities: {`);
  ln(`    specialisms: ['signal-marketplace'] as const,`);
  ln(`    creative_agents: [], channels: [], pricingModels: ['cpm'] as const, config: {},`);
  ln(`  },`);
  ln(`  statusMappers: {},`);
  ln(`  accounts: {`);
  ln(`    resolve: async () => ({ id: 'acc_1', ctx_metadata: {}, authInfo: { kind: 'api_key' } }),`);
  ln(`  },`);
  ln(`  signals: {`);
  ln(`    getSignals: async (req, ctx) => ({ signals: [/* ... */], sandbox: true }),`);
  ln(`    activateSignal: async (req, ctx) => ({ /* ... */ }),`);
  ln(`  },`);
  ln(`};`);
  ln();
  ln(`serve(() => createAdcpServerFromPlatform(platform, {`);
  ln(`  name: 'My Signals Agent',`);
  ln(`  version: '1.0.0',`);
  ln(`})); // http://localhost:3001/mcp`);
  ln('```');
  ln();
  ln(
    `Compile-time enforcement: \`RequiredPlatformsFor<S>\` catches missing specialism methods. Capability projection auto-derives \`get_adcp_capabilities\` blocks (\`audience_targeting\`, \`conversion_tracking\`, \`compliance_testing.scenarios\`, etc.). Idempotency, RFC 9421 signing, async tasks, status normalization, and sync-completion webhook auto-emit are framework-owned.`
  );
  ln();
  ln(
    `Lower-level option: \`createAdcpServer({ signals: { getSignals: ... } })\` from \`@adcp/sdk/server/legacy/v5\` — handler-bag API. Still fully supported, the substrate the platform path calls into. Use when you need fine control over individual handlers, mid-migration from a v5 codebase, or custom-shaped tools the platform interface doesn't yet model. \`wrapEnvelope(inner, { replayed, context, operationId })\` from \`@adcp/sdk/server\` attaches protocol envelope fields with the per-error-code allowlist (IDEMPOTENCY_CONFLICT drops \`replayed\`).`
  );
  ln();

  // --- Quick start ---
  ln(`## Quick Start (Client)`);
  ln();
  ln('```typescript');
  ln(`import { ADCPMultiAgentClient } from '@adcp/sdk';`);
  ln();
  ln(`const client = ADCPMultiAgentClient.simple('https://agent.example.com/mcp/', {`);
  ln(`  authToken: process.env.ADCP_TOKEN,`);
  ln(`});`);
  ln(`const agent = client.agent('default-agent');`);
  ln();
  ln(`// Discover products`);
  ln(`const products = await agent.getProducts({ buying_mode: 'brief', brief: 'coffee brands' });`);
  ln(`if (products.status === 'completed') console.log(products.data.products);`);
  ln();
  ln(`// Create a media buy`);
  ln(`const buy = await agent.createMediaBuy({`);
  ln(`  account: { account_id: 'acct_1' },`);
  ln(`  brand: { domain: 'coffee.example.com' },`);
  ln(`  start_time: 'asap',`);
  ln(`  end_time: '2026-06-01T00:00:00Z',`);
  ln(`  packages: [{ buyer_ref: 'pkg-1', product_id: 'prod_1', pricing_option_id: 'cpm_1', budget: 5000 }],`);
  ln(`});`);
  ln('```');
  ln();

  // --- Error Handling ---
  ln(`## Error Handling`);
  ln();
  ln(`When \`result.success\` is \`false\`, use \`result.adcpError\` for programmatic handling:`);
  ln();
  ln(`- \`result.error\` — Human-readable string (e.g., \`"RATE_LIMITED: Too many requests"\`)`);
  ln(`- \`result.adcpError.code\` — Error code (e.g., \`RATE_LIMITED\`, \`INVALID_REQUEST\`)`);
  ln(
    `- \`result.adcpError.recovery\` — \`'transient'\` (retry), \`'correctable'\` (fix request), or \`'terminal'\` (give up)`
  );
  ln(`- \`result.adcpError.retryAfterMs\` — Milliseconds to wait before retrying`);
  ln(`- \`result.adcpError.field\` / \`result.adcpError.suggestion\` — Hints for correctable errors`);
  ln(`- \`result.adcpError.synthetic\` — \`true\` when inferred from unstructured text`);
  ln(`- \`result.correlationId\` — Correlation ID for tracing across agents`);
  ln();
  ln(
    `Use \`isRetryable(result)\` and \`getRetryDelay(result)\` for retry logic. \`TaskResult\` is a discriminated union — \`if (result.success)\` narrows \`data\` to \`T\`; \`if (!result.success)\` guarantees \`error: string\` and \`status: 'failed'\`.`
  );
  ln();
  ln('```typescript');
  ln('if (!result.success) {');
  ln('  if (isRetryable(result)) {');
  ln('    await sleep(getRetryDelay(result)); // ms, defaults to 5000');
  ln("  } else if (result.adcpError?.recovery === 'correctable') {");
  ln("    console.log('Fix:', result.adcpError.suggestion, 'Field:', result.adcpError.field);");
  ln('  } else {');
  ln("    console.error(result.error, 'Correlation:', result.correlationId);");
  ln('  }');
  ln('}');
  ln('```');
  ln();
  ln(
    `For exhaustive handling across all seven statuses, prefer the \`match()\` dispatcher (fluent method on every result returned from the SDK, or free function import):`
  );
  ln();
  ln('```typescript');
  ln('const label = result.match!({');
  ln('  completed: r => `OK: ${JSON.stringify(r.data)}`,');
  ln('  failed: r => `Error: ${r.adcpError?.code ?? r.error}`,');
  ln('  submitted: r => `Pending: poll ${r.metadata.taskId}`,');
  ln("  'governance-denied': r => `Denied: ${r.adcpError?.code ?? r.error}`,");
  ln('  working: r => `Running: ${r.metadata.taskId}`,');
  ln("  'input-required': r => `Needs input: ${r.metadata.inputRequest?.question}`,");
  ln('  deferred: r => `Deferred: ${r.deferred?.token}`,');
  ln('});');
  ln('// Optional `_` catchall makes every arm optional:');
  ln('// const label = result.match!({ completed: r => JSON.stringify(r.data), _: r => r.status });');
  ln('```');
  ln();
  ln(
    `TypeScript enforces exhaustiveness at compile time when the \`_\` catchall is omitted — missing an arm is a type error, not a runtime surprise. The \`!\` is because \`TaskResultBase.match\` is declared optional so hand-constructed result literals (tests, middleware) stay valid; every result returned from the SDK has \`.match\` attached. For hand-constructed literals, use the free function \`match(result, handlers)\` or call \`attachMatch(result)\` first.`
  );
  ln();

  // --- Idempotency ---
  ln(`## Idempotency (mutating requests)`);
  ln();
  ln(
    `AdCP v3 requires \`idempotency_key\` on every mutating request (\`create_media_buy\`, \`update_media_buy\`, \`activate_signal\`, all \`sync_*\`, \`si_send_message\`, etc.). The SDK auto-generates a UUID v4 when callers don't supply one, reuses it across internal retries, and surfaces it on the result:`
  );
  ln();
  ln('```typescript');
  ln('const result = await client.createMediaBuy({ account, brand, start_time, end_time, packages });');
  ln('result.metadata.idempotency_key  // key that was sent (auto-generated or caller-supplied)');
  ln('result.metadata.replayed         // true if this was a cached replay from a prior retry');
  ln('```');
  ln();
  ln(`**Two things agents with side effects MUST handle:**`);
  ln();
  ln(
    `1. **Side-effect suppression on \`replayed: true\`.** If your agent emits notifications, writes LLM memory, or fires downstream tool calls on the response, check \`result.metadata.replayed\` before acting. A cached replay means the side effects already fired on the original call.`
  );
  ln();
  ln('```typescript');
  ln('if (result.success && !result.metadata.replayed) {');
  ln('  await notify(`Campaign ${result.data.media_buy_id} created`);');
  ln('  await memory.write({ campaign_id: result.data.media_buy_id });');
  ln('}');
  ln('```');
  ln();
  ln(
    `2. **Agent re-plan vs. network retry.** A network retry (same bytes, socket timeout) reuses the same key — the SDK handles this. An agent re-plan (LLM re-ran its planner and produced a different payload) means a NEW intent — mint a fresh key by calling the method again without passing one. Reusing the prior key with a different payload returns \`IdempotencyConflictError\`.`
  );
  ln();
  ln(
    `**Typed errors:** on failure, \`result.errorInstance\` carries a typed \`ADCPError\` subclass for codes with dedicated classes — currently \`IdempotencyConflictError\` and \`IdempotencyExpiredError\`. Prefer \`instanceof\` checks over switching on \`adcpError.code\` strings.`
  );
  ln();
  ln('```typescript');
  ln("import { IdempotencyConflictError, IdempotencyExpiredError } from '@adcp/sdk';");
  ln();
  ln('if (result.errorInstance instanceof IdempotencyConflictError) {');
  ln('  // Agent re-planned with different payload. Retry with a fresh key.');
  ln('  // result.errorInstance.idempotencyKey carries the key the server omitted.');
  ln('}');
  ln('if (result.errorInstance instanceof IdempotencyExpiredError) {');
  ln('  // Key past replay window. If you know the prior call succeeded, look up');
  ln('  // by natural key (e.g., get_media_buys by context.internal_campaign_id).');
  ln('  // Otherwise mint a fresh key.');
  ln('}');
  ln('```');
  ln();
  ln(
    `**BYOK** (persist keys in your DB across process restarts): you own the replay-window boundary. Ask the client for the seller's declared TTL:`
  );
  ln();
  ln('```typescript');
  ln('const ttl = await client.getIdempotencyReplayTtlSeconds();');
  ln('// Returns the declared number. Throws ConfigurationError if the seller is v3');
  ln('// but omits adcp.idempotency.replay_ttl_seconds — the SDK does NOT default to');
  ln('// 24h, because a silent default misleads retry-sensitive flows. Returns');
  ln('// undefined on v2 sellers (pre-idempotency-envelope).');
  ln('```');
  ln();
  ln(
    `Pass your persisted key with \`useIdempotencyKey(key)\` — it validates against the spec pattern (\`^[A-Za-z0-9_.:-]{16,255}$\`) before the network round-trip:`
  );
  ln();
  ln('```typescript');
  ln("import { useIdempotencyKey } from '@adcp/sdk';");
  ln('const key = await db.getOrCreateIdempotencyKey(campaign.id);');
  ln('await client.createMediaBuy({ ...params, ...useIdempotencyKey(key) });');
  ln('```');
  ln();
  ln(
    `**Crash-recovery cookbook.** For an end-to-end recipe (natural-key lookup after restart, \`IdempotencyConflictError\` / \`IdempotencyExpiredError\` handling, \`metadata.replayed\` as side-effect gate, Postgres schema), see [\`docs/guides/idempotency-crash-recovery.md\`](./guides/idempotency-crash-recovery.md).`
  );
  ln();

  // --- ext.adcp Extension Namespace ---
  ln(`## ext.adcp Extension Namespace`);
  ln();
  ln(
    `**\`ext.adcp.*\` namespace.** The SDK reserves keys under \`ext.adcp.*\` for read-by-agent extensions that don't yet warrant their own AdCP spec field. Agents that recognize a key act on it; agents that don't recognize it ignore it silently (per AdCP \`ext\` semantics: accepted-without-error). The namespace is transport-neutral — it travels in the \`ext\` envelope field on both MCP and A2A transports. Keys in this namespace are hints **inbound to seller/responder agents** from the SDK or test tooling; **buyer agents building production flows MUST NOT emit \`ext.adcp.*\` keys**.`
  );
  ln();
  ln(`| Key | Stamped by | Purpose |`);
  ln(`|-----|-----------|---------|`);
  ln(
    `| \`ext.adcp.disable_sandbox\` | \`adcp storyboard run --no-sandbox\` | Hint (value: \`true\`) to bypass internal sandbox routing and exercise real adapter paths. Seller agents that honor this key serve production-shaped responses regardless of internal sandbox heuristics (env-var fallbacks, brand-domain detection, fixture substitutes). |`
  );
  ln();
  ln(
    `Third-party extensions MUST use a distinct namespace (e.g. \`ext.com.example.*\`) to avoid collisions with future \`ext.adcp.*\` keys.`
  );
  ln();

  // --- Tools by domain ---
  ln(`## Tools`);
  ln();
  ln(
    `Every tool is an MCP tool called via \`agent.<methodName>(params)\`. Returns \`TaskResult<T>\` with \`status\`, \`data\`, \`error\`, \`adcpError\`, \`correlationId\`, \`deferred\`, or \`submitted\`.`
  );
  ln();

  for (const domain of TOOL_DOMAINS) {
    const domainTools = groups.get(domain);
    if (!domainTools?.length) continue;

    ln(`### ${domainLabel(domain)}`);
    ln();

    for (const tool of domainTools) {
      ln(`#### \`${tool.name}\``);
      ln();
      const toolDesc = tool.reqDescription.split('.')[0].trim();
      if (toolDesc) ln(`${toolDesc}.`);
      ln();

      ln(`**Request:**`);
      if (tool.requiredFields.length) {
        ln(`- Required: ${tool.requiredFields.map(f => `\`${f}\``).join(', ')}`);
      }
      if (tool.optionalFields.length) {
        // Show first 8 optional fields to keep it scannable
        const shown = tool.optionalFields.slice(0, 8);
        const more = tool.optionalFields.length - shown.length;
        let optLine = `- Optional: ${shown.map(f => `\`${f}\``).join(', ')}`;
        if (more > 0) optLine += `, +${more} more`;
        ln(optLine);
      }
      if (!tool.requiredFields.length && !tool.optionalFields.length) {
        ln(`- (no parameters)`);
      }
      ln();

      // Response contract — most common drift cause is agents dropping a
      // required response field. Surface the happy-path shape right next to
      // the request shape so skill authors don't have to leave the file.
      if (tool.resRequiredFields.length || tool.resOptionalFields.length) {
        ln(`**Response (success branch):**`);
        if (tool.resRequiredFields.length) {
          ln(`- Required: ${tool.resRequiredFields.map(f => `\`${f}\``).join(', ')}`);
        }
        if (tool.resOptionalFields.length) {
          const shown = tool.resOptionalFields.slice(0, 8);
          const more = tool.resOptionalFields.length - shown.length;
          let optLine = `- Optional: ${shown.map(f => `\`${f}\``).join(', ')}`;
          if (more > 0) optLine += `, +${more} more`;
          ln(optLine);
        }
        ln();
      }

      const gotchas = TOOL_GOTCHAS[tool.name];
      if (gotchas?.length) {
        ln(`**Watch out:**`);
        for (const note of gotchas) {
          ln(`- ${note}`);
        }
        ln();
      }
    }

    // Deep dive links for this domain
    const deepDives = domainDeepDives(domain);
    if (deepDives.length) {
      ln(`**Deep dive:**`);
      for (const link of deepDives) {
        ln(`- ${link}`);
      }
      ln();
    }
  }

  // --- TMP operations (not MCP tools) ---
  const tmpEntry = index.schemas['trusted-match'];
  if (tmpEntry?.operations) {
    ln(`### ${domainLabel('trusted-match')}`);
    ln();
    ln(`Real-time execution layer. These are HTTP operations, not MCP tools.`);
    ln();
    for (const [kebab, op] of Object.entries<any>(tmpEntry.operations)) {
      ln(`#### \`${kebabToSnake(kebab)}\``);
      ln();
      const desc = op.request?.description?.split('.')[0]?.trim();
      ln(desc ? `${desc}.` : '');
      ln();
    }
  }

  // --- Common flows (from storyboards) ---
  if (storyboards.length) {
    ln(`## Common Flows`);
    ln();
    ln(
      `These are the standard tool call sequences from the AdCP storyboards. Each flow shows the tools called in order.`
    );
    ln();

    // Group by track and show the most representative flows
    const byTrack = new Map<string, StoryboardSummary[]>();
    for (const sb of storyboards) {
      if (!byTrack.has(sb.track)) byTrack.set(sb.track, []);
      byTrack.get(sb.track)!.push(sb);
    }

    for (const [track, sbs] of byTrack) {
      ln(`### ${trackLabel(track)}`);
      ln();
      for (const sb of sbs) {
        ln(`**${sb.title}** — ${sb.summary}`);
        if (sb.flow) {
          ln(`Flow: \`${sb.flow}\``);
        }
        ln();
      }
    }
  }

  // --- Error codes ---
  if (errorCodes.length) {
    ln(`## Error Codes`);
    ln();
    ln(
      `Agents use the \`recovery\` classification to decide what to do: \`transient\` → retry after delay, \`correctable\` → fix parameters and retry, \`terminal\` → stop and report.`
    );
    ln();
    ln(`| Code | Recovery | Description |`);
    ln(`|------|----------|-------------|`);
    for (const ec of errorCodes) {
      ln(`| \`${ec.code}\` | ${ec.recovery} | ${ec.description} |`);
    }
    ln();
    ln(`Unknown codes: fall back to the HTTP status code (4xx = correctable, 5xx = transient).`);
    ln();
  }

  // --- Test scenarios ---
  if (scenarios.length) {
    ln(`## Test Scenarios`);
    ln();
    ln(`Run compliance tests with \`adcp test <agent> <scenario>\`. ${scenarios.length} built-in scenarios:`);
    ln();
    ln(`| Scenario | What it tests |`);
    ln(`|----------|---------------|`);
    for (const s of scenarios) {
      ln(`| \`${s.name}\` | ${s.description} |`);
    }
    ln();
    ln(
      `**Deep dive:** Storyboard YAML definitions live at \`https://adcontextprotocol.org/compliance/{version}/\` and are mirrored locally in \`compliance/cache/{version}/\` after \`npm run sync-schemas\`.`
    );
    ln();
    ln(
      `**Fictional entities:** \`compliance/cache/{version}/universal/fictional-entities.yaml\` defines all fictional companies used in storyboards and training (advertisers, agencies, publishers, data providers). Aligned to the character bible at docs.adcontextprotocol.org/specs/character-bible. All domains use the \`.example\` TLD. Sandbox brands (advertisers) are resolvable via AgenticAdvertising.org.`
    );
    ln();
  }

  // --- Seeding fixtures (seller-side helpers) ---
  ln(`### Seeding fixtures for compliance (seller-side)`);
  ln();
  ln(
    `Group A storyboards seed fixtures via \`comply_test_controller.seed_product\` (and the other \`seed_*\` scenarios) before calling the spec tool. Two SDK helpers bridge this to \`createAdcpServer\`:`
  );
  ln();
  ln(
    `- **\`mergeSeedProduct\`** (plus \`mergeSeedPricingOption\`, \`mergeSeedCreative\`, \`mergeSeedPlan\`, \`mergeSeedMediaBuy\`): permissive merge of a sparse storyboard fixture onto the seller's baseline defaults. \`undefined\`/\`null\` keep base; arrays replace by default; well-known id-keyed lists (\`pricing_options\`, \`publisher_properties\`, \`packages\`, \`assets\`, plan \`findings\`) overlay by id so seeding one entry doesn't drop the rest.`
  );
  ln(
    `- **\`bridgeFromTestControllerStore(store, productDefaults)\`**: wires a \`Map<string, unknown>\` seed store into \`get_products\` responses automatically. Sandbox requests merge seeded + handler products (seeded wins collisions); production traffic (no sandbox marker, or a resolved non-sandbox account) skips the bridge.`
  );
  ln();
  ln(
    `Wire on \`createAdcpServer({ testController: bridgeFromTestControllerStore(store, baseline) })\`. See \`skills/build-seller-agent/SKILL.md\` for the full pattern alongside \`createComplyController\`.`
  );
  ln();

  // --- Anti-façade upstream-traffic recorder ---
  ln(`### Anti-façade upstream-traffic recording (\`@adcp/sdk/upstream-recorder\`)`);
  ln();
  ln(
    `Storyboards declaring \`check: upstream_traffic\` (runner-output-contract v2.0.0, spec PR adcontextprotocol/adcp#3816) verify that an adapter actually called its upstream platform with the storyboard-supplied identifiers — distinguishing a real adapter from one returning shape-valid AdCP responses without touching upstream. Adopters opt in by advertising \`query_upstream_traffic\` on their \`comply_test_controller\`.`
  );
  ln();
  ln(
    `\`@adcp/sdk/upstream-recorder\` is the producer-side reference middleware: a sandbox-only-by-default helper that wraps the adapter's HTTP layer with per-principal isolation, record-time secret redaction, ring-buffer + TTL eviction, and a \`query()\` method that maps onto the controller wire shape via \`toQueryUpstreamTrafficResponse()\`. Wire-up is four steps — boot recorder, wrap fetch, scope handlers in \`runWithPrincipal\`, return \`toQueryUpstreamTrafficResponse(recorder.query(...))\` from your \`comply_test_controller\`'s \`query_upstream_traffic\` scenario. Worked example at \`examples/hello_signals_adapter_marketplace.ts\`. See \`skills/build-seller-agent/SKILL.md\` § "Opting into \`upstream_traffic\`" for the full pattern, including multi-tenant principal resolution.`
  );
  ln();

  // --- Key types ---
  ln(`## Key Types`);
  ln();
  ln(`See docs/TYPE-SUMMARY.md for field-level detail. Key types at a glance:`);
  ln();
  ln(`| Type | Purpose |`);
  ln(`|------|---------|`);
  ln(`| \`AgentConfig\` | Agent connection config (uri, protocol, auth) |`);
  ln(
    `| \`TaskResult<T>\` | Return type of every tool call (status + data/error/adcpError/correlationId/deferred/submitted) |`
  );
  ln(`| \`InputHandler\` | Callback for agent clarification requests |`);
  ln(`| \`ConversationContext\` | Passed to InputHandler with messages, question, helpers |`);
  ln(`| \`Product\` | Advertising inventory item with formats, pricing, targeting |`);
  ln(`| \`MediaBuy\` | Purchased campaign with packages, budget, schedule |`);
  ln(`| \`CreativeAsset\` | Creative with type, format, dimensions, status |`);
  ln(`| \`Targeting\` | Audience criteria (geo, demo, behavioral, contextual, device) |`);
  ln(`| \`PricingOption\` | Price model (CPM, vCPM, CPC, CPCV, CPV, CPP, CPA, FlatRate, Time) |`);
  ln(`| \`GovernanceConfig\` | Buyer-side governance middleware config |`);
  ln();

  // --- Task statuses ---
  ln(`## Task Statuses`);
  ln();
  ln(`Every tool call returns a \`TaskResult\` with one of these statuses:`);
  ln();
  ln(`- \`completed\` — Success. Data in \`result.data\`.`);
  ln(`- \`input-required\` — Agent needs clarification. Use \`InputHandler\` or \`result.deferred.resume(answer)\`.`);
  ln(`- \`submitted\` — Long-running. Poll via \`result.submitted.waitForCompletion()\` or use webhooks.`);
  ln(`- \`working\` — In progress (intermediate, usually not seen by callers).`);
  ln(`- \`deferred\` — Requires human decision. Token in \`result.deferred.token\`.`);
  ln(`- \`governance-denied\` — Blocked by governance middleware.`);
  ln();
  ln(`**Deep dive:** docs/guides/ASYNC-DEVELOPER-GUIDE.md, docs/guides/ASYNC-API-REFERENCE.md`);
  ln();

  // --- Protocols ---
  ln(`## Protocols`);
  ln();
  ln(
    `AdCP tools are served over MCP (Model Context Protocol) or A2A (Agent-to-Agent). The client auto-detects based on \`AgentConfig.protocol\`. MCP endpoints end with \`/mcp/\`. Auth is via bearer token in \`x-adcp-auth\` header.`
  );
  ln();
  ln(`**Deep dive:** docs/development/PROTOCOL_DIFFERENCES.md`);
  ln();

  // --- Discovery ---
  ln(`## Discovery`);
  ln();
  ln(
    `Publishers declare agents in \`/.well-known/adagents.json\`. Brands declare identity in \`/.well-known/brand.json\`. Use \`PropertyCrawler\` or \`adcp registry\` CLI to discover agents.`
  );
  ln();

  // --- Where to go next ---
  ln(`## Where to Read More`);
  ln();
  ln(`These docs are available locally in the repo and hosted at ${DOCS_BASE_URL}/`);
  ln();

  const docLinks: [string, string][] = [
    ['Full type signatures', 'TYPE-SUMMARY.md'],
    ['Getting started / install', 'getting-started.md'],
    ['Build a server-side agent', 'guides/BUILD-AN-AGENT.md'],
    ['Async patterns (polling, webhooks, deferred)', 'guides/ASYNC-DEVELOPER-GUIDE.md'],
    ['Async API reference', 'guides/ASYNC-API-REFERENCE.md'],
    ['Input handler patterns', 'guides/HANDLER-PATTERNS-GUIDE.md'],
    ['Webhook configuration', 'guides/PUSH-NOTIFICATION-CONFIG.md'],
    ['Real-world code examples', 'guides/REAL-WORLD-EXAMPLES.md'],
    ['CLI reference', 'CLI.md'],
    ['Zod runtime validation', 'ZOD-SCHEMAS.md'],
    ['Testing strategy', 'guides/TESTING-STRATEGY.md'],
    ['Protocol differences (MCP vs A2A)', 'development/PROTOCOL_DIFFERENCES.md'],
    ['TypeDoc API reference', 'api/index.html'],
  ];

  ln(`| Need | Local path | Hosted |`);
  ln(`|------|-----------|--------|`);
  for (const [need, docPath] of docLinks) {
    ln(`| ${need} | docs/${docPath} | [link](${DOCS_BASE_URL}/${docPath}) |`);
  }
  ln();
  ln(`JSON schemas (source of truth): \`schemas/cache/latest/index.json\` (local only)`);
  ln();

  // --- External links ---
  ln(`## External Resources`);
  ln();
  ln(`- Documentation: ${DOCS_BASE_URL}/`);
  ln(`- npm: https://www.npmjs.com/package/@adcp/sdk`);
  ln(`- Spec: https://adcontextprotocol.org`);
  ln(`- CLI: \`npx @adcp/sdk@latest\``);
  ln();

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// TYPE-SUMMARY.md generator
// ---------------------------------------------------------------------------

function generateTypeSummary(index: SchemaIndex, tools: ToolInfo[]): string {
  const version = getLibraryVersion();
  const now = new Date().toISOString().split('T')[0];

  const lines: string[] = [];
  const ln = (s = '') => lines.push(s);

  ln(`# AdCP Type Summary`);
  ln();
  ln(`> Generated at: ${now}`);
  ln(`> @adcp/sdk v${version}`);
  ln();
  ln(
    `Curated reference of the types that matter for using the AdCP client. For full generated types see \`src/lib/types/tools.generated.ts\` and \`src/lib/types/core.generated.ts\`.`
  );
  ln();

  // --- Client types ---
  ln(`## Client Types`);
  ln();
  ln('```typescript');
  ln(`interface AgentConfig {`);
  ln(`  id: string;`);
  ln(`  name: string;`);
  ln(`  agent_uri: string;             // MCP: ends with /mcp/, A2A: base domain`);
  ln(`  protocol: 'mcp' | 'a2a';`);
  ln(`  auth_token?: string;           // Bearer token`);
  ln(`  oauth_tokens?: AgentOAuthTokens;`);
  ln(`  headers?: Record<string, string>;`);
  ln(`}`);
  ln();
  ln(`interface TaskResult<T = any> {`);
  ln(`  success: boolean;`);
  ln(`  status: 'completed' | 'deferred' | 'submitted' | 'input-required'`);
  ln(`        | 'working' | 'governance-denied';`);
  ln(`  data?: T;`);
  ln(`  error?: string;`);
  ln(`  deferred?: DeferredContinuation<T>;`);
  ln(`  submitted?: SubmittedContinuation<T>;`);
  ln(`  governance?: GovernanceCheckResult;`);
  ln(`  metadata: {`);
  ln(`    taskId: string;`);
  ln(`    taskName: string;`);
  ln(`    agent: { id: string; name: string; protocol: string };`);
  ln(`    responseTimeMs: number;`);
  ln(`    timestamp: string;`);
  ln(`    clarificationRounds: number;`);
  ln(`  };`);
  ln(`  conversation?: Message[];`);
  ln(`}`);
  ln();
  ln(`type InputHandler = (context: ConversationContext) => InputHandlerResponse;`);
  ln();
  ln(`interface ConversationContext {`);
  ln(`  messages: Message[];`);
  ln(`  inputRequest: {`);
  ln(`    question: string;`);
  ln(`    field?: string;`);
  ln(`    expectedType?: string;`);
  ln(`    suggestions?: string[];`);
  ln(`  };`);
  ln(`  taskId: string;`);
  ln(`  agent: { id: string; name: string; protocol: string };`);
  ln(`  attempt: number;`);
  ln(`  maxAttempts: number;`);
  ln(`  deferToHuman(): Promise<{ defer: true; token: string }>;`);
  ln(`  abort(reason?: string): never;`);
  ln(`}`);
  ln('```');
  ln();

  // --- Tool request/response shapes ---
  ln(`## Tool Request/Response Shapes`);
  ln();
  ln(
    `Each tool is called as \`agent.<methodName>(params)\` and returns \`TaskResult<ResponseType>\`. Below are the key fields for each tool's request. Fields marked with \`*\` are required.`
  );
  ln();

  const groups = groupByDomain(tools);

  for (const domain of TOOL_DOMAINS) {
    const domainTools = groups.get(domain);
    if (!domainTools?.length) continue;

    ln(`### ${domainLabel(domain)}`);
    ln();

    for (const tool of domainTools) {
      const tsDesc = tool.reqDescription.split('.')[0].trim();
      ln(`**\`${tool.name}\`**${tsDesc ? ` — ${tsDesc}.` : ''}`);
      ln();

      const reqFields = [
        ...tool.requiredFields.map(f => `  ${f}  // required`),
        ...tool.optionalFields.map(f => `  ${f}`),
      ];

      if (reqFields.length) {
        ln(`_Request:_`);
        ln('```');
        ln(`{`);
        for (const f of reqFields) {
          ln(f);
        }
        ln(`}`);
        ln('```');
        ln();
      }

      const resFields = [
        ...tool.resRequiredFields.map(f => `  ${f}  // required`),
        ...tool.resOptionalFields.map(f => `  ${f}`),
      ];

      if (resFields.length) {
        ln(`_Response (success branch):_`);
        ln('```');
        ln(`{`);
        for (const f of resFields) {
          ln(f);
        }
        ln(`}`);
        ln('```');
      }
      ln();
    }
  }

  // --- Core schema types ---
  ln(`## Core Data Types`);
  ln();
  ln(`These are the main domain objects returned in tool responses. Defined in \`src/lib/types/core.generated.ts\`.`);
  ln();

  const coreTypes: [string, string][] = [
    [
      'Product',
      'Advertising inventory item — has product_id, name, format_ids, pricing_options, delivery_type, publisher_properties',
    ],
    ['MediaBuy', 'Purchased campaign — has media_buy_id, status, packages, total_budget, start_time, end_time'],
    ['Package', 'Line item within a media buy — has package_id, product_id, budget, pricing_option_id, targeting'],
    ['CreativeAsset', 'Creative with assets — has creative_id, name, type, format_id, status, manifest'],
    ['Targeting', 'Audience criteria — geographic, demographic, behavioral, contextual, device, daypart, signals'],
    ['PricingOption', 'Discriminated union by pricing_model — see variant details below'],
    ['Format', 'Creative format specification — has format_id, name, channel, requirements (typed asset constraints)'],
    [
      'Proposal',
      'Suggested media plan — has proposal_id, status (draft|committed), allocations, delivery_forecast, insertion_order',
    ],
    ['SignalDefinition', 'Data signal — has signal_id, name, description, value_type, targeting constraints, pricing'],
    ['PropertyList', 'Managed allow/block list — has list_id, name, list_type (allow|block), sources, filters'],
    ['ContentStandards', 'Brand safety config — has standards_id, name, scope, policy entries, calibration exemplars'],
    ['Catalog', 'Data feed — typed (offering, product, store, etc.) with items, URL, or inline data'],
    ['Offering', 'Promotable item with asset groups — used in sponsored intelligence and catalog creatives'],
  ];

  ln(`| Type | Key Fields |`);
  ln(`|------|-----------|`);
  for (const [name, desc] of coreTypes) {
    ln(`| \`${name}\` | ${desc} |`);
  }
  ln();

  // --- PricingOption Variants ---
  ln(`## PricingOption Variants`);
  ln();
  ln(`All variants share these common fields:`);
  ln();
  ln(`| Field | Type | Required | Description |`);
  ln(`|-------|------|----------|-------------|`);
  ln(`| \`pricing_option_id\` | string | yes | Unique identifier within a product |`);
  ln(`| \`pricing_model\` | string | yes | Discriminant — determines which variant |`);
  ln(`| \`currency\` | string | yes | ISO 4217 currency code |`);
  ln(`| \`fixed_price\` | number | no | Fixed price (mutually exclusive with floor_price for auction) |`);
  ln(`| \`floor_price\` | number | no | Minimum acceptable bid (auction pricing) |`);
  ln(`| \`max_bid\` | boolean | no | Whether fixed_price is a ceiling vs exact price |`);
  ln(`| \`price_guidance\` | PriceGuidance | no | Percentile guidance (p25, p50, p75, p90) |`);
  ln(`| \`min_spend_per_package\` | number | no | Minimum spend requirement |`);
  ln();
  ln(`Variant-specific fields:`);
  ln();
  ln(`| Variant | pricing_model | Extra Required Fields |`);
  ln(`|---------|--------------|----------------------|`);
  ln(`| \`CPMPricingOption\` | \`'cpm'\` | — (common fields only) |`);
  ln(`| \`VCPMPricingOption\` | \`'vcpm'\` | — |`);
  ln(`| \`CPCPricingOption\` | \`'cpc'\` | — |`);
  ln(`| \`CPCVPricingOption\` | \`'cpcv'\` | — |`);
  ln(
    `| \`CPVPricingOption\` | \`'cpv'\` | \`parameters: { view_threshold: number \\| { duration_seconds: number } }\` |`
  );
  ln(`| \`CPPPricingOption\` | \`'cpp'\` | — |`);
  ln(`| \`CPAPricingOption\` | \`'cpa'\` | — |`);
  ln(`| \`FlatRatePricingOption\` | \`'flat_rate'\` | — |`);
  ln(`| \`TimeBasedPricingOption\` | \`'time'\` | — |`);
  ln();
  ln(
    `**CPV note**: The \`parameters.view_threshold\` is required and defines what counts as a "view". Use a number for percentage-based thresholds or \`{ duration_seconds }\` for time-based thresholds.`
  );
  ln();

  // --- Enums ---
  ln(`## Key Enums`);
  ln();

  const keyEnums: [string, string][] = [
    ['buying_mode', "'brief' | 'wholesale' | 'refine'"],
    ['delivery_type', "'guaranteed' | 'non_guaranteed'"],
    ['pricing_model', "'cpm' | 'vcpm' | 'cpc' | 'cpcv' | 'cpv' | 'cpp' | 'cpa' | 'flat_rate' | 'time'"],
    ['media_buy_status', "'draft' | 'pending_review' | 'active' | 'paused' | 'completed' | 'cancelled'"],
    ['creative_status', "'draft' | 'pending_review' | 'approved' | 'rejected' | 'active' | 'archived'"],
    [
      'channels (MediaChannel)',
      "'display' | 'olv' | 'social' | 'search' | 'ctv' | 'linear_tv' | 'radio' | 'streaming_audio' | 'podcast' | 'dooh' | 'ooh' | 'print' | 'cinema' | 'email' | 'gaming' | 'retail_media' | 'influencer' | 'affiliate' | 'product_placement' | 'sponsored_intelligence'",
    ],
    ['task_status', "'completed' | 'working' | 'submitted' | 'input_required' | 'deferred'"],
    ['pacing', "'even' | 'asap' | 'front_loaded'"],
  ];

  ln(`| Enum | Values |`);
  ln(`|------|--------|`);
  for (const [name, values] of keyEnums) {
    ln(`| \`${name}\` | ${values} |`);
  }
  ln();

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log('Generating agent documentation...');

  const index = loadIndex();
  const tools = collectTools(index);
  const errorCodes = parseErrorCodes();
  const storyboards = parseStoryboards();
  const scenarios = parseTestScenarios();

  console.log(
    `Found ${tools.length} tools, ${errorCodes.length} error codes, ${storyboards.length} storyboards, ${scenarios.length} test scenarios`
  );

  // Fail loudly if TOOL_GOTCHAS grows stale. A tool rename would otherwise
  // silently drop its "Watch out:" block from llms.txt with no CI signal.
  const knownToolNames = new Set(tools.map(t => t.name));
  const orphanGotchas = Object.keys(TOOL_GOTCHAS).filter(name => !knownToolNames.has(name));
  if (orphanGotchas.length > 0) {
    console.error(
      `ERROR: TOOL_GOTCHAS references unknown tool(s): ${orphanGotchas.join(', ')}. ` +
        `A tool was renamed or removed — update TOOL_GOTCHAS in scripts/generate-agent-docs.ts.`
    );
    process.exit(1);
  }

  const llmsTxt = generateLlmsTxt(index, tools, errorCodes, storyboards, scenarios);
  const typeSummary = generateTypeSummary(index, tools);

  const llmsChanged = writeIfChanged(LLMS_TXT_PATH, llmsTxt);
  const typesChanged = writeIfChanged(TYPE_SUMMARY_PATH, typeSummary);

  if (llmsChanged) {
    console.log(`✅ Updated ${path.relative(ROOT, LLMS_TXT_PATH)}`);
  } else {
    console.log(`⏭️  ${path.relative(ROOT, LLMS_TXT_PATH)} is up to date`);
  }

  if (typesChanged) {
    console.log(`✅ Updated ${path.relative(ROOT, TYPE_SUMMARY_PATH)}`);
  } else {
    console.log(`⏭️  ${path.relative(ROOT, TYPE_SUMMARY_PATH)} is up to date`);
  }
}

main();
