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

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..');
const SCHEMA_CACHE_DIR = path.join(ROOT, 'schemas/cache/latest');
const INDEX_PATH = path.join(SCHEMA_CACHE_DIR, 'index.json');
const LLMS_TXT_PATH = path.join(ROOT, 'docs/llms.txt');
const TYPE_SUMMARY_PATH = path.join(ROOT, 'docs/TYPE-SUMMARY.md');
const ERROR_CODES_PATH = path.join(ROOT, 'src/lib/types/error-codes.ts');
const STORYBOARDS_DIR = path.join(ROOT, 'storyboards');
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

// GitHub Pages base URL for published docs
const DOCS_BASE_URL = 'https://adcontextprotocol.github.io/adcp-client';

// Storyboards to skip (meta files, not real flows)
const SKIP_STORYBOARDS = new Set(['schema.yaml', 'schema_validation.yaml']);

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

      tools.push({
        name: kebabToSnake(kebab),
        kebab,
        domain,
        reqDescription: task.request?.description || reqSchema?.description || '',
        resDescription: task.response?.description || resSchema?.description || '',
        requiredFields: required,
        optionalFields: optional,
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
  if (!existsSync(ERROR_CODES_PATH)) return [];
  const src = readFileSync(ERROR_CODES_PATH, 'utf8');

  const entries: ErrorCodeEntry[] = [];
  // Match: CODE: { description: '...' or "...", recovery: '...' }
  const re = /(\w+):\s*\{\s*description:\s*(?:'([^']+)'|"([^"]+)"),\s*recovery:\s*'(\w+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    entries.push({ code: m[1], description: m[2] || m[3], recovery: m[4] as any });
  }
  return entries;
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
  if (!existsSync(STORYBOARDS_DIR)) return [];

  const files = readdirSync(STORYBOARDS_DIR)
    .filter(f => f.endsWith('.yaml') && !SKIP_STORYBOARDS.has(f))
    .sort();

  return files
    .map(f => {
      const content = readFileSync(path.join(STORYBOARDS_DIR, f), 'utf8');
      return {
        id: yamlField(content, 'id') || f.replace('.yaml', ''),
        title: yamlField(content, 'title') || '',
        summary: yamlField(content, 'summary') || '',
        track: yamlField(content, 'track') || '',
        requiredTools: yamlListField(content, 'required_tools'),
        flow: extractToolFlow(content),
      };
    })
    .filter(s => s.title); // skip empty/broken files
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
function extractToolFlow(content: string): string {
  const tools: string[] = [];
  const re = /^\s+task:\s*(\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const tool = m[1];
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
  ln(`> Library: @adcp/client v${version}`);
  ln(`> AdCP major version: 3`);
  ln(`> Canonical URL: ${DOCS_BASE_URL}/llms.txt`);
  ln();
  ln(`## What is AdCP`);
  ln();
  ln(
    `AdCP is an open protocol for AI agents to buy, manage, and optimize advertising programmatically. It defines MCP tools that agents call on publisher ad servers — discover inventory, create media buys, sync creatives, manage brand safety, and track delivery. Every tool follows request/response JSON schemas; the TypeScript client wraps them with async task handling, conversation context, and governance middleware.`
  );
  ln();

  // --- Quick start ---
  ln(`## Quick Start`);
  ln();
  ln('```typescript');
  ln(`import { ADCPMultiAgentClient } from '@adcp/client';`);
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

  // --- Tools by domain ---
  ln(`## Tools`);
  ln();
  ln(
    `Every tool is an MCP tool called via \`agent.<methodName>(params)\`. Returns \`TaskResult<T>\` with \`status\`, \`data\`, \`error\`, \`deferred\`, or \`submitted\`.`
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

      if (tool.requiredFields.length) {
        ln(`Required: ${tool.requiredFields.map(f => `\`${f}\``).join(', ')}`);
      }
      if (tool.optionalFields.length) {
        // Show first 8 optional fields to keep it scannable
        const shown = tool.optionalFields.slice(0, 8);
        const more = tool.optionalFields.length - shown.length;
        let optLine = `Optional: ${shown.map(f => `\`${f}\``).join(', ')}`;
        if (more > 0) optLine += `, +${more} more`;
        ln(optLine);
      }
      ln();
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
    ln(`**Deep dive:** storyboards/ directory has full YAML definitions for each flow`);
    ln();
  }

  // --- Key types ---
  ln(`## Key Types`);
  ln();
  ln(`See docs/TYPE-SUMMARY.md for field-level detail. Key types at a glance:`);
  ln();
  ln(`| Type | Purpose |`);
  ln(`|------|---------|`);
  ln(`| \`AgentConfig\` | Agent connection config (uri, protocol, auth) |`);
  ln(`| \`TaskResult<T>\` | Return type of every tool call (status + data/error/deferred/submitted) |`);
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
  ln(`- \`governance-denied\` / \`governance-escalated\` — Blocked or flagged by governance middleware.`);
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
  ln(`- npm: https://www.npmjs.com/package/@adcp/client`);
  ln(`- Spec: https://adcontextprotocol.org`);
  ln(`- CLI: \`npx @adcp/client\``);
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
  ln(`> @adcp/client v${version}`);
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
  ln(`        | 'working' | 'governance-denied' | 'governance-escalated';`);
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

      const allFields = [
        ...tool.requiredFields.map(f => `  ${f}  // required`),
        ...tool.optionalFields.map(f => `  ${f}`),
      ];

      if (allFields.length) {
        ln('```');
        ln(`{`);
        for (const f of allFields) {
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
    ['PricingOption', 'Discriminated by pricing_model: cpm, vcpm, cpc, cpcv, cpv, cpp, cpa, flat_rate, time'],
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

  // --- Enums ---
  ln(`## Key Enums`);
  ln();

  const keyEnums: [string, string][] = [
    ['buying_mode', "'brief' | 'wholesale' | 'refine'"],
    ['delivery_type', "'guaranteed' | 'non_guaranteed'"],
    ['pricing_model', "'cpm' | 'vcpm' | 'cpc' | 'cpcv' | 'cpv' | 'cpp' | 'cpa' | 'flat_rate' | 'time'"],
    ['media_buy_status', "'draft' | 'pending_review' | 'active' | 'paused' | 'completed' | 'cancelled'"],
    ['creative_status', "'draft' | 'pending_review' | 'approved' | 'rejected' | 'active' | 'archived'"],
    ['channels', "'display' | 'video' | 'audio' | 'dooh' | 'ctv' | 'social' | 'native' | 'search'"],
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
