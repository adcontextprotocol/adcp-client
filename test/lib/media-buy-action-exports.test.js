const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');

test('action helpers have ESM/CJS and root/server public export parity', async () => {
  const cjs = require('@adcp/sdk/media-buy/actions');
  const esm = await import('@adcp/sdk/media-buy/actions');
  const root = require('@adcp/sdk');
  for (const name of [
    'assessMediaBuyAction',
    'assessProductAction',
    'assessProposalAction',
    'assessActionAvailability',
    'preflightMediaBuyActions',
    'refreshMediaBuyActions',
    'evaluateChangeTermConstraints',
  ]) {
    assert.equal(typeof cjs[name], 'function', name);
    assert.equal(typeof esm[name], 'function', name);
    assert.equal(root[name], cjs[name], name);
  }
  assert.equal(typeof require('@adcp/sdk/server').mediaBuyActionResolver.resolve, 'function');
});

test('browser action assessment tree-shakes without Node, protocol transports, or the proposal verifier', async () => {
  const result = await build({
    stdin: {
      contents:
        "import { assessMediaBuyAction } from '@adcp/sdk/media-buy/actions'; console.log(assessMediaBuyAction({ action: 'pause' }));",
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
    minify: true,
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(
    inputs.every(path => !/node_modules|negotiation|protocols\/|schemas\.generated/.test(path)),
    inputs.join('\n')
  );
  assert.ok(result.outputFiles[0].contents.length < 45000);
});

test('public task union is narrow, results discriminate, and generated wire objects are accepted', () => {
  const directory = mkdtempSync(join(process.cwd(), '.context-action-types-'));
  try {
    const source = join(directory, 'consumer.mts');
    writeFileSync(
      source,
      `
import { assessMediaBuyAction, preflightMediaBuyActions, type MediaBuyTask, type ActionAvailability, type ChangeTermConstraints, type ProposalChangeTerm } from '@adcp/sdk/media-buy/actions';
import { mediaBuyActionResolver, assertUpdateMediaBuyAllowed } from '@adcp/sdk/server';
import { preflightUpdateMediaBuy, getAvailableActions, type LiveMediaBuyAction, type MediaBuyActionId, type ControlMediaBuyRequest, type UpdateMediaBuyRequest } from '@adcp/sdk';
import type { MediaBuy, CanonicalProduct, CanonicalProposal } from '../src/lib/types/core.generated.js';
const capAction: MediaBuyActionId = 'update_media_buy_frequency_cap';
// @ts-expect-error arbitrary strings are not MediaBuy actions
const invalidAction: MediaBuyActionId = 'definitely_not_an_action';
const control: MediaBuyTask = 'control_media_buy';
// @ts-expect-error arbitrary AdCP tasks cannot route a MediaBuy action
const invalid: MediaBuyTask = 'get_products';
const bound: ChangeTermConstraints = { kind: 'budget', max_delta_percent: 10 };
// @ts-expect-error every canonical constraint requires at least one portable bound
const unbounded: ChangeTermConstraints = { kind: 'budget' };
// @ts-expect-error closed constraint vocabulary
const opaque: ChangeTermConstraints = { kind: 'script' };
const promised: ProposalChangeTerm = { term_id: 'right_budget', action: 'increase_budget', service_mode: 'self_serve', constraints: bound };
declare const buy: MediaBuy;
declare const product: CanonicalProduct;
declare const proposal: CanonicalProposal;
const result = assessMediaBuyAction({ action: 'pause', buy, product, proposal });
if (result.availability.status === 'available_now') {
  const task: MediaBuyTask | undefined = result.availability.nonDefaultRoute;
  result.availability.mode;
} else {
  result.availability.reason;
  result.availability.compat?.reason;
}
const projection = mediaBuyActionResolver.resolve({ buy, decide: () => ({ authorization: true, governance: true, policy: true }) });
const projectedBuy = { ...buy, available_actions: projection.available_actions };
const readable: LiveMediaBuyAction[] = getAvailableActions(projectedBuy).actions;
preflightUpdateMediaBuy(projectedBuy, { paused: true });
preflightUpdateMediaBuy(projectedBuy, { budget_cap_timezone: null }, { proposal });
preflightMediaBuyActions(projectedBuy, { budget_cap_timezone: null }, { proposal, task: 'update_media_buy' });
assertUpdateMediaBuyAllowed(projectedBuy, { paused: true });
declare const controlRequest: ControlMediaBuyRequest;
declare const updateRequest: UpdateMediaBuyRequest;
preflightMediaBuyActions(projectedBuy, controlRequest, { task: 'control_media_buy' });
preflightUpdateMediaBuy(projectedBuy, updateRequest);
const checked = preflightMediaBuyActions(buy, { paused: true }, { task: control });
if (checked.ok) checked.assessments.forEach(item => item.mode);
`
    );
    try {
      execFileSync(
        process.execPath,
        [
          resolve('node_modules/typescript/bin/tsc'),
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          '--target',
          'es2022',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          source,
        ],
        { encoding: 'utf8', timeout: 60000 }
      );
    } catch (error) {
      assert.fail(String(error.stdout ?? error.message));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
