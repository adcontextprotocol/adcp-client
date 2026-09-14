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
import { assessMediaBuyAction, preflightMediaBuyActions, type MediaBuyTask, type ActionAvailability, type ChangeTermConstraints } from '@adcp/sdk/media-buy/actions';
import { mediaBuyActionResolver, assertUpdateMediaBuyAllowed } from '@adcp/sdk/server';
import { preflightUpdateMediaBuy } from '@adcp/sdk';
import type { MediaBuy, CanonicalProduct, CanonicalProposal } from '../src/lib/types/core.generated.js';
const control: MediaBuyTask = 'control_media_buy';
// @ts-expect-error arbitrary AdCP tasks cannot route a MediaBuy action
const invalid: MediaBuyTask = 'get_products';
const bound: ChangeTermConstraints = { kind: 'budget', max_delta_percent: 10 };
// @ts-expect-error closed constraint vocabulary
const opaque: ChangeTermConstraints = { kind: 'script' };
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
preflightUpdateMediaBuy(projectedBuy, { paused: true });
assertUpdateMediaBuyAllowed(projectedBuy, { paused: true });
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
