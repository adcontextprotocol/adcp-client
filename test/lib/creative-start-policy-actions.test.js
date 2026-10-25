const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { build } = require('esbuild');
require('tsx/cjs');
const {
  canonicalMediaBuyActionTasks,
  commercialMediaBuyActionNames,
} = require('../../scripts/lib/canonical-media-buy-action-tasks.ts');

const ROOT = path.resolve(__dirname, '../..');
const ACTION = 'update_creative_start_policy';
const FIELD = 'start_requires_all_creatives_approved';
const VERSION = '3.3-beta.0';
const accept = () => ({ authorization: true, governance: true, policy: true });
const request = (package_id = 'p1', value = true) => ({ packages: [{ package_id, [FIELD]: value }] });
const entry = () => ({
  action: ACTION,
  task: 'control_media_buy',
  mode: 'self_serve',
  applicable_package_ids: ['p1'],
});
function buy(extra = {}) {
  return {
    media_buy_id: 'nova_buy',
    revision: 3,
    status: 'active',
    packages: [{ package_id: 'p1' }, { package_id: 'p2' }],
    available_actions: [entry()],
    ...extra,
  };
}
let scratch;
let api;
let bundleOptions;

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-start-policy-actions-'));
  let schemaRoot = process.env.ADCP_TEST_PROTOCOL_SCHEMA_ROOT;
  if (!schemaRoot) {
    schemaRoot = path.join(scratch, 'candidate');
    const pin = fs.readFileSync(path.join(ROOT, 'ADCP_VERSION'), 'utf8').trim();
    const pinned = path.join(ROOT, 'schemas/cache', pin);
    for (const relative of [
      'enums/media-buy-valid-action.json',
      'core/media-buy-available-action-id.json',
      'core/canonical-media-buy-action.json',
      'enums/canonical-media-buy-action.json',
      'media-buy/change-term.json',
    ]) {
      fs.mkdirSync(path.dirname(path.join(schemaRoot, relative)), { recursive: true });
      fs.copyFileSync(path.join(pinned, relative), path.join(schemaRoot, relative));
    }
    const actionPath = path.join(schemaRoot, 'core/media-buy-available-action-id.json');
    const ids = JSON.parse(fs.readFileSync(actionPath, 'utf8'));
    ids.anyOf.push({ type: 'string', const: ACTION });
    ids.enumMetadata[ACTION] = { update_fields: [`packages[].${FIELD}`] };
    fs.writeFileSync(actionPath, JSON.stringify(ids));
    const routePath = path.join(schemaRoot, 'core/canonical-media-buy-action.json');
    const routes = JSON.parse(fs.readFileSync(routePath, 'utf8'));
    routes.oneOf.push({ properties: { task: { const: 'control_media_buy' }, action: { const: ACTION } } });
    fs.writeFileSync(routePath, JSON.stringify(routes));
  }
  const schema = relative => JSON.parse(fs.readFileSync(path.join(schemaRoot, relative), 'utf8'));
  const routes = canonicalMediaBuyActionTasks(schema('core/canonical-media-buy-action.json'));
  const term = schema('media-buy/change-term.json');
  const commercial = commercialMediaBuyActionNames(
    schema('enums/canonical-media-buy-action.json').enum,
    term.properties.action
  );
  assert.deepEqual(routes[ACTION], ['control_media_buy']);
  assert.ok(!commercial.includes(ACTION), 'startup controls must never become commercial change rights');
  const constraints = structuredClone(term['x-adcp-validation'].verifier_constraints.constraint_action_compatibility);
  delete constraints.on_violation;
  const metadata = path.join(scratch, 'action-metadata.generated.ts');
  fs.writeFileSync(
    metadata,
    [
      `export const CANONICAL_ACTION_TASKS = ${JSON.stringify(routes)} as const;`,
      `export const CHANGE_CONSTRAINT_ACTIONS = ${JSON.stringify(constraints)} as const;`,
      `export const CHANGE_TERM_ACTIONS = ${JSON.stringify(commercial)} as const;`,
      `export const LEGACY_AVAILABLE_ACTIONS = ${JSON.stringify(schema('enums/media-buy-valid-action.json').enum)} as const;`,
    ].join('\n')
  );
  const fields = path.join(scratch, 'update-fields.generated.ts');
  execFileSync('npx', ['tsx', path.join(ROOT, 'scripts/generate-media-buy-update-fields.ts')], {
    cwd: ROOT,
    env: { ...process.env, SCHEMA_DIR: schemaRoot, SCHEMA_PATH: '', OUT_PATH: fields },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fs.writeFileSync(
    fields,
    fs.readFileSync(fields, 'utf8').replaceAll("from './types'", `from '${path.join(ROOT, 'src/lib/media-buy/types')}'`)
  );
  const entries = [
    'src/lib/media-buy/action-assessment.ts',
    'src/lib/media-buy/action-contracts.ts',
    'src/lib/media-buy/preflight.ts',
    'src/lib/server/media-buy-action-resolver.ts',
  ];
  bundleOptions = {
    stdin: {
      contents: entries.map(relative => `export * from ${JSON.stringify(path.join(ROOT, relative))};`).join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [
      {
        name: 'candidate-creative-start-metadata',
        setup(builder) {
          builder.onResolve({ filter: /action-metadata\.generated$/ }, () => ({ path: metadata }));
          builder.onResolve({ filter: /update-fields\.generated$/ }, () => ({ path: fields }));
        },
      },
    ],
  };
  const result = await build(bundleOptions);
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, mod, mod.exports);
  api = mod.exports;
});
after(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

function assess(state = buy(), extra = {}) {
  return api.assessActionAvailability(state, ACTION, { adcpVersion: VERSION, request: request(), ...extra });
}

test('startup is operational live authority on pending or active aggregate buys, without a commercial promise', () => {
  for (const status of ['pending_creatives', 'pending_start', 'active', 'paused']) {
    for (const value of [true, false]) {
      const state = buy({ status });
      const patch = request('p1', value);
      const before = structuredClone({ state, patch });
      const result = assess(state, { request: patch });
      assert.equal(result.status, 'available_now');
      assert.equal(result.authority, 'live_metadata');
      assert.equal(result.term, undefined);
      assert.equal(result.nonDefaultRoute, 'control_media_buy');
      assert.equal(api.preflightUpdateMediaBuy(state, patch, { adcpVersion: VERSION }).ok, true);
      assert.equal(api.preflightMediaBuyActions(state, patch, { adcpVersion: VERSION }).ok, true);
      assert.deepEqual({ state, patch }, before);
    }
  }
});

test('startup rejects old, alpha, absent, and malformed served versions across assessment and preflight', () => {
  for (const adcpVersion of [
    undefined,
    '3.2',
    '3.2.7',
    '3.3-alpha',
    '3.3.0-alpha.1',
    '3.3-beta..0',
    '3.3.0-beta.01',
    '3.3.0-01',
    '3.3.0-9',
    '3.3.0-bet',
    '3.3.0-beta.1+build..3',
    '3.3.0-',
    '3.3.0+',
    '03.3-beta.0',
    '3.03-beta.0',
    '3.3.00-beta.0',
    '9007199254740992.0.0',
    'nonsense',
  ]) {
    const state = buy();
    assert.equal(assess(state, { adcpVersion }).status, 'currently_unavailable', String(adcpVersion));
    assert.equal(api.preflightUpdateMediaBuy(state, request(), { adcpVersion }).ok, false, String(adcpVersion));
    assert.equal(api.preflightMediaBuyActions(state, request(), { adcpVersion }).ok, false, String(adcpVersion));
    assert.equal(api.actionFitsErrorDetails(ACTION, adcpVersion ?? '3.2.7'), false);
  }
  for (const adcpVersion of [
    '3.3-beta',
    '3.3-beta.0',
    '3.3.0-beta.0',
    '3.3.0-beta.0+001.build-3',
    '3.3-rc.1',
    '3.3',
    '3.3.1',
    '3.3.1-alpha',
    '3.4',
    '4.0-alpha',
  ]) {
    assert.equal(assess(buy(), { adcpVersion }).status, 'available_now', adcpVersion);
    assert.equal(api.liveActionFitsVersion(entry(), adcpVersion), true);
    assert.equal(api.actionFitsErrorDetails(ACTION, adcpVersion), true);
  }
});

test('only an explicit current seller scope establishes package eligibility, never aggregate active or policy false', () => {
  for (const applicable_package_ids of [undefined, [], ['unknown'], ['p1', 'p1']]) {
    const state = buy({ available_actions: [{ ...entry(), applicable_package_ids }] });
    assert.equal(assess(state).status, 'currently_unavailable');
    assert.equal(api.preflightUpdateMediaBuy(state, request(), { adcpVersion: VERSION }).ok, false);
  }
  assert.equal(assess(buy(), { request: request('p2') }).status, 'currently_unavailable');
  for (const current of [
    { package_id: 'p1', canceled: true },
    ...['completed', 'canceled', 'rejected', 'unknown'].map(status => ({ package_id: 'p1', status })),
  ]) {
    const state = buy({ packages: [current] });
    assert.equal(assess(state).status, 'currently_unavailable');
  }
  assert.equal(assess(buy({ packages: [] })).status, 'currently_unavailable');
  const unscoped = buy({
    packages: [{ package_id: 'p1', [FIELD]: false }],
    available_actions: [{ ...entry(), applicable_package_ids: undefined }],
  });
  assert.equal(assess(unscoped).status, 'currently_unavailable');
});

test('startup cannot borrow commercial terms or creative-sync routing, and validates boolean inputs', () => {
  for (const change_term_id of ['invented', 'startup_right']) {
    assert.equal(assess(buy({ available_actions: [{ ...entry(), change_term_id }] })).status, 'currently_unavailable');
  }
  for (const task of [undefined, 'sync_creatives', 'refine_proposals']) {
    assert.equal(assess(buy({ available_actions: [{ ...entry(), task }] })).status, 'currently_unavailable');
  }
  for (const value of [null, 0, 1, 'true', {}, []]) {
    assert.equal(assess(buy(), { request: request('p1', value) }).status, 'currently_unavailable');
  }
  const fabricated = { term_id: 'startup_right', action: ACTION, service_mode: 'self_serve' };
  assert.ok(api.changeTermIssues([fabricated]).length);
  assert.equal(
    assess(buy({ accepted_proposal: { commercial_terms: { change_terms: [fabricated] } }, available_actions: [] }))
      .status,
    'currently_unavailable'
  );
  for (const mode of ['self_serve', 'conditional_self_serve', 'seller_managed', 'requires_approval']) {
    const state = buy({ available_actions: [{ ...entry(), mode }] });
    assert.equal(assess(state).mode, mode);
    const result = api.preflightUpdateMediaBuy(state, request(), { adcpVersion: VERSION });
    assert.equal(result.ok, true);
    assert.equal(result.requiresAsyncFlow, mode !== 'self_serve');
  }
});

test('seller projection requires its own gates and exact scope, independently from ordinary product change terms', () => {
  const options = {
    buy: buy({ available_actions: undefined }),
    adcpVersion: VERSION,
    decide() {
      throw new Error('Startup authority must not be fabricated as a change term');
    },
    metadata: { [ACTION]: { ...accept(), applicable_package_ids: ['p1'] } },
    productPolicy: [{ product_id: 'streamhaus_video', allowed_actions: [{ action: 'pause', modes: ['self_serve'] }] }],
  };
  const result = api.mediaBuyActionResolver.resolve(options);
  assert.deepEqual(result.available_actions, [entry()]);
  for (const decision of [
    { ...accept() },
    { ...accept(), applicable_package_ids: [] },
    { ...accept(), applicable_package_ids: ['unknown'] },
    ...['authorization', 'governance', 'policy'].flatMap(gate =>
      [false, 'unknown'].map(value => ({ ...accept(), applicable_package_ids: ['p1'], [gate]: value }))
    ),
  ]) {
    const denied = api.mediaBuyActionResolver.resolve({ ...options, metadata: { [ACTION]: decision } });
    assert.equal(denied.available_actions.length, 0);
    assert.equal(denied.unavailable[0].action, ACTION);
  }
  for (const adcpVersion of ['3.2.7', '3.3-alpha']) {
    assert.equal(api.mediaBuyActionResolver.resolve({ ...options, adcpVersion }).available_actions.length, 0);
  }
  const badRequest = api.mediaBuyActionResolver.resolve({ ...options, request: request('p2') });
  assert.deepEqual(badRequest.available_actions, [entry()]);
  assert.equal(badRequest.request_assessments[0].status, 'currently_unavailable');
  const stale = api.mediaBuyActionResolver.resolve({ ...options, request: { ...request(), revision: 2 } });
  assert.equal(stale.request_assessments[0].code, 'CONFLICT');
});

test('naming remains operational and creative assignment changes keep sync_creatives routing', () => {
  const renamed = buy({
    available_actions: [{ action: 'update_name', mode: 'self_serve', task: 'control_media_buy' }],
  });
  assert.equal(api.preflightUpdateMediaBuy(renamed, { name: 'Nova launch' }, { adcpVersion: VERSION }).ok, true);
  const term = { term_id: 'traffic', action: 'update_creative_assignments', service_mode: 'self_serve' };
  const traffic = buy({
    accepted_proposal: { commercial_terms: { change_terms: [term] } },
    available_actions: [
      { action: term.action, task: 'sync_creatives', mode: 'self_serve', change_term_id: term.term_id },
    ],
  });
  const result = api.assessActionAvailability(traffic, term.action, {
    adcpVersion: VERSION,
    request: { packages: [{ package_id: 'p1', creative_assignments: [{ creative_id: 'nova_image' }] }] },
  });
  assert.equal(result.status, 'available_now');
  assert.equal(result.nonDefaultRoute, 'sync_creatives');
});

test('candidate buyer assessment remains a small dependency-free browser bundle', async () => {
  const result = await build({
    ...bundleOptions,
    stdin: {
      contents: `import { assessMediaBuyAction } from ${JSON.stringify(path.join(ROOT, 'src/lib/media-buy/action-assessment.ts'))}; console.log(assessMediaBuyAction({ action: ${JSON.stringify(ACTION)} }));`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    platform: 'browser',
    format: 'esm',
    minify: true,
    metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(
    inputs.every(input => !/node_modules|negotiation|protocols\/|schemas\.generated/.test(input)),
    inputs.join('\n')
  );
  assert.ok(result.outputFiles[0].contents.length < 45000);
});
