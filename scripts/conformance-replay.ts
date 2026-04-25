#!/usr/bin/env tsx
/**
 * Deterministic conformance replay — load each specialism storyboard yaml,
 * walk every phase[].step[], dispatch step.sample_request via the SDK's
 * in-process `dispatchTestRequest()` against a reference SDK-built agent,
 * and validate the response against the schema-derived contract.
 *
 * No Claude in the loop. No HTTP transport. Runs in seconds. Catches the
 * drift classes the matrix catches (discriminator omissions, missing
 * required fields, wrong response shapes) at the cost of a single CI step.
 *
 * Status: v0 — targets `creative-template` only with an inline reference
 * agent. Expand to other specialisms by adding entries to REFERENCE_AGENTS.
 *
 * Usage:
 *   npx tsx scripts/conformance-replay.ts [--filter <id>] [--verbose]
 *
 * Options:
 *   --filter <id>   Only run the specialism whose id matches (e.g.
 *                    `creative_template`, `signal_marketplace`). Repeatable.
 *   --verbose       Print every step, not just failures.
 *
 * Exit code:
 *   0 = all checked steps passed.
 *   1 = at least one step failed.
 *   2 = harness error (yaml parse, missing fixtures, etc.).
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  createAdcpServer,
  createIdempotencyStore,
  memoryBackend,
  type AdcpServer,
} from '../src/lib/server';
import {
  displayRender,
  htmlAsset,
  urlRender,
  imageAssetSlot,
  textAssetSlot,
  urlAssetSlot,
} from '../src/lib';
import { validateResponse } from '../src/lib/validation/schema-validator';
import { injectContext } from '../src/lib/testing/storyboard/context';
import type { StoryboardContext } from '../src/lib/testing/storyboard/types';

const REPO_ROOT = resolve(__dirname, '..');
const COMPLIANCE_DIR = join(REPO_ROOT, 'compliance/cache/latest/specialisms');

interface CliArgs {
  filters: string[];
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const filters: string[] = [];
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--filter') {
      const v = argv[++i];
      if (!v) {
        console.error('--filter requires a value');
        process.exit(2);
      }
      filters.push(v);
    } else if (argv[i] === '--verbose') verbose = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.error(`Usage: conformance-replay [--filter <id>] [--verbose]`);
      process.exit(0);
    }
  }
  return { filters, verbose };
}

// ---------------------------------------------------------------------------
// Reference agents — one per specialism. v0 has creative-template; expand
// by adding factory functions here. Each must be a plain `() => AdcpServer`.
// ---------------------------------------------------------------------------

function createCreativeTemplateAgent(): AdcpServer {
  const AGENT_URL = 'http://reference-agent.test/mcp';

  function banner(id: string, width: number, height: number) {
    return {
      format_id: { agent_url: AGENT_URL, id },
      name: `Banner ${width}x${height}`,
      type: 'display' as const,
      renders: [displayRender({ role: 'primary', dimensions: { width, height } })],
      assets: [
        imageAssetSlot({
          asset_id: 'image',
          required: true,
          requirements: { formats: ['jpg', 'png', 'webp'], max_file_size_kb: 200 },
        }),
        textAssetSlot({ asset_id: 'headline', required: false, requirements: { max_length: 90 } }),
        urlAssetSlot({ asset_id: 'click_url', required: false }),
      ],
    };
  }
  const formats = [
    banner('display_300x250', 300, 250),
    banner('display_728x90', 728, 90),
    banner('display_320x50', 320, 50),
  ];

  function render(targetFid: { agent_url: string; id: string }, manifest: any) {
    const fmt = formats.find((f) => f.format_id.id === targetFid.id);
    const dims = (fmt?.renders[0] as any)?.dimensions ?? { width: 300, height: 250 };
    const html =
      `<a href="${manifest?.assets?.click_url?.url ?? '#'}" target="_blank">` +
      `<img src="${manifest?.assets?.image?.url ?? ''}" width="${dims.width}" height="${dims.height}" />` +
      `<span>${manifest?.assets?.headline?.content ?? 'Ad'}</span></a>`;
    return {
      format_id: targetFid,
      assets: { serving_tag: htmlAsset({ content: html }) },
    };
  }

  return createAdcpServer({
    name: 'Reference Creative Template Agent',
    version: '1.0.0',
    idempotency: createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86400 }),
    resolveSessionKey: () => 'conformance-replay',
    capabilities: { specialisms: ['creative-template'] },
    creative: {
      listCreativeFormats: async (params) => {
        let result = formats;
        if (params.type) result = result.filter((f) => f.type === params.type);
        if (params.max_width != null)
          result = result.filter((f) => (f.renders[0] as any).dimensions.width <= params.max_width!);
        if (params.max_height != null)
          result = result.filter((f) => (f.renders[0] as any).dimensions.height <= params.max_height!);
        return { formats: result };
      },
      buildCreative: async (params) => {
        if (params.target_format_ids?.length) {
          return {
            creative_manifests: params.target_format_ids.map((fid: any) =>
              render(fid, params.creative_manifest)
            ),
            sandbox: true,
          };
        }
        const fid = params.target_format_id ?? params.creative_manifest?.format_id;
        return { creative_manifest: render(fid, params.creative_manifest), sandbox: true };
      },
      previewCreative: async (params: any) => {
        const fid = params.creative_manifest?.format_id;
        const fmt = formats.find((f) => f.format_id.id === fid?.id);
        const dims = (fmt?.renders[0] as any)?.dimensions ?? { width: 300, height: 250 };
        return {
          response_type: 'single',
          previews: [
            {
              preview_id: `prev_${Date.now()}`,
              input: { name: params.creative_manifest?.name ?? 'Preview' },
              renders: [
                urlRender({
                  render_id: `r_${Date.now()}`,
                  preview_url: 'https://example.com/preview.png',
                  role: 'primary',
                  dimensions: dims,
                }),
              ],
            },
          ],
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        };
      },
    },
  });
}

const REFERENCE_AGENTS: Record<string, () => AdcpServer> = {
  creative_template: createCreativeTemplateAgent,
};

// ---------------------------------------------------------------------------
// Storyboard loading + step execution
// ---------------------------------------------------------------------------

interface StoryboardStep {
  id: string;
  title?: string;
  task?: string;
  sample_request?: Record<string, unknown>;
  validations?: Array<Record<string, any>>;
  stateful?: boolean;
}

interface StoryboardPhase {
  id: string;
  title?: string;
  steps?: StoryboardStep[];
}

interface Storyboard {
  id: string;
  title?: string;
  phases?: StoryboardPhase[];
}

async function loadStoryboard(specialismDir: string): Promise<Storyboard | null> {
  const indexPath = join(specialismDir, 'index.yaml');
  try {
    const raw = await readFile(indexPath, 'utf8');
    const parsed = parseYaml(raw) as Storyboard;
    return parsed;
  } catch (err) {
    console.error(`[conformance-replay] failed to load ${indexPath}: ${(err as Error).message}`);
    return null;
  }
}

interface StepResult {
  storyboardId: string;
  phaseId: string;
  stepId: string;
  task: string;
  outcome: 'pass' | 'fail' | 'skip';
  failures: string[];
  unimplementedChecks: string[];
}

// Check types this v0 implements. Anything outside this set is logged as
// 'unimplemented' and counted as a skip — silent fall-through would hide
// gaps from storyboard authors who add a new check expecting it to gate.
const IMPLEMENTED_CHECKS = new Set([
  'response_schema',
  'field_present',
  'field_value',
]);

// Check types that fundamentally need transport-layer state (HTTP status,
// auth headers, error envelopes) that in-process dispatch doesn't surface.
// These are forever-skip in this harness; an HTTP-mode v2 would handle them.
const TRANSPORT_ONLY_CHECKS = new Set([
  'status_code',
  'http_status',
  'http_status_in',
  'on_401_require_header',
  'resource_equals_agent_url',
]);

function getByPath(obj: unknown, path: string): unknown {
  // Supports `a.b[0].c` style paths from storyboard validations.
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

async function runStep(
  server: AdcpServer,
  storyboardId: string,
  phaseId: string,
  step: StoryboardStep,
  context: StoryboardContext
): Promise<StepResult> {
  const result: StepResult = {
    storyboardId,
    phaseId,
    stepId: step.id,
    task: step.task ?? '<no task>',
    outcome: 'skip',
    failures: [],
    unimplementedChecks: [],
  };

  if (!step.task || !step.sample_request) return result;

  // Resolve $generate:uuid_v4#alias and $context.* placeholders. Reuses the
  // same expander the live storyboard runner uses so behaviour is identical.
  const resolvedArgs = injectContext(step.sample_request, context);

  const response = await server
    .dispatchTestRequest({
      method: 'tools/call',
      params: { name: step.task, arguments: resolvedArgs },
    })
    .catch((err: unknown): { isError: true; structuredContent: { _dispatchError: string } } => ({
      isError: true,
      structuredContent: { _dispatchError: err instanceof Error ? err.message : String(err) },
    }));

  if ('_dispatchError' in (response.structuredContent ?? {})) {
    result.outcome = 'fail';
    result.failures.push(
      `dispatch threw: ${(response.structuredContent as { _dispatchError: string })._dispatchError}`
    );
    return result;
  }

  const structured = response.structuredContent;
  if (response.isError) {
    result.outcome = 'fail';
    result.failures.push(
      `tool returned isError: ${JSON.stringify(structured ?? response.content).slice(0, 200)}`
    );
    return result;
  }

  if (!structured) {
    result.outcome = 'fail';
    result.failures.push('response missing structuredContent');
    return result;
  }

  let allPassed = true;
  for (const v of step.validations ?? []) {
    const check = v.check as string;
    if (check === 'response_schema') {
      const outcome = validateResponse(step.task, structured);
      if (!outcome.valid) {
        allPassed = false;
        const issues = outcome.issues
          .slice(0, 3)
          .map((i) => `${i.pointer}: ${i.message}`)
          .join('; ');
        result.failures.push(`response_schema: ${issues}`);
      }
    } else if (check === 'field_present') {
      if (getByPath(structured, v.path as string) === undefined) {
        allPassed = false;
        result.failures.push(`field_present ${v.path}: missing`);
      }
    } else if (check === 'field_value') {
      const actual = getByPath(structured, v.path as string);
      if (actual !== v.value) {
        allPassed = false;
        result.failures.push(
          `field_value ${v.path}: got ${JSON.stringify(actual)}, want ${JSON.stringify(v.value)}`
        );
      }
    } else if (TRANSPORT_ONLY_CHECKS.has(check)) {
      // Transport-only checks require an HTTP-mode harness; permanently
      // out of scope for in-process dispatch. Surface explicitly so storyboard
      // authors know the check is being deliberately not enforced here.
      result.unimplementedChecks.push(`${check} (transport-only)`);
    } else if (!IMPLEMENTED_CHECKS.has(check)) {
      result.unimplementedChecks.push(check);
    }
  }

  result.outcome = allPassed ? 'pass' : 'fail';
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const allSpecialisms = (await readdir(COMPLIANCE_DIR)).filter((d) => !d.startsWith('.'));
  const targets = args.filters.length === 0
    ? allSpecialisms
    : allSpecialisms.filter((d) => args.filters.some((f) => d.includes(f) || d.replace(/-/g, '_').includes(f)));

  if (targets.length === 0) {
    console.error(`[conformance-replay] no specialisms matched filter; available:`);
    for (const d of allSpecialisms) console.error(`  ${d}`);
    process.exit(2);
  }

  const allResults: StepResult[] = [];
  let storyboardsTested = 0;
  let storyboardsSkipped = 0;

  for (const dir of targets) {
    const storyboard = await loadStoryboard(join(COMPLIANCE_DIR, dir));
    if (!storyboard) {
      storyboardsSkipped++;
      continue;
    }
    const factory = REFERENCE_AGENTS[storyboard.id];
    if (!factory) {
      // Soft-skip: a yaml without a registered reference agent is expected
      // (we add specialism coverage incrementally). Don't fail the run for
      // it — that would block unrelated PRs that touch storyboard yaml.
      if (args.verbose) {
        console.error(`◇ ${storyboard.id} — skipped (no reference agent registered)`);
      }
      storyboardsSkipped++;
      continue;
    }

    console.error(`\n▶ ${storyboard.id} (${storyboard.title ?? ''})`);
    storyboardsTested++;
    const server = factory();
    const context: StoryboardContext = {}; // shared across all steps in this storyboard

    for (const phase of storyboard.phases ?? []) {
      for (const step of phase.steps ?? []) {
        const res = await runStep(server, storyboard.id, phase.id, step, context);
        allResults.push(res);

        if (res.outcome === 'pass') {
          if (args.verbose) console.error(`  ✓ ${phase.id}/${step.id} (${res.task})`);
        } else if (res.outcome === 'fail') {
          console.error(`  ✗ ${phase.id}/${step.id} (${res.task})`);
          for (const f of res.failures) console.error(`      ${f}`);
        } else if (args.verbose) {
          console.error(`  ◇ ${phase.id}/${step.id} (skip — no task or sample_request)`);
        }
      }
    }
  }

  const passed = allResults.filter((r) => r.outcome === 'pass').length;
  const failed = allResults.filter((r) => r.outcome === 'fail').length;
  const skipped = allResults.filter((r) => r.outcome === 'skip').length;
  const unimplemented = new Map<string, number>();
  for (const r of allResults) {
    for (const c of r.unimplementedChecks) {
      unimplemented.set(c, (unimplemented.get(c) ?? 0) + 1);
    }
  }

  console.error('\n' + '═'.repeat(60));
  console.error(`Conformance replay summary`);
  console.error('═'.repeat(60));
  console.error(`Storyboards: tested=${storyboardsTested}, skipped=${storyboardsSkipped}`);
  console.error(`Steps: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (unimplemented.size > 0) {
    console.error(`\nUnimplemented checks (logged but not enforced):`);
    for (const [check, n] of [...unimplemented.entries()].sort((a, b) => b[1] - a[1])) {
      console.error(`  ${check}: ${n}`);
    }
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[conformance-replay] fatal: ${err?.stack ?? err}`);
  process.exit(2);
});
