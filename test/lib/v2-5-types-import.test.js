// Smoke test: the v2.5 type bundle is importable from `@adcp/sdk/types/v2-5`
// and exposes the expected per-tool request/response surface. This locks the
// downstream contract so adapter code can rely on `import type
// { CreateMediaBuyRequest } from '@adcp/sdk/types/v2-5'` without a separate
// path resolution.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('v2.5 type bundle', () => {
  const distRoot = path.join(__dirname, '..', '..', 'dist', 'lib', 'types', 'v2-5');

  test('dist/lib/types/v2-5/index.{js,d.ts} both exist', () => {
    assert.ok(fs.existsSync(path.join(distRoot, 'index.js')), 'index.js must exist');
    assert.ok(fs.existsSync(path.join(distRoot, 'index.d.ts')), 'index.d.ts must exist');
    assert.ok(fs.existsSync(path.join(distRoot, 'tools.generated.d.ts')), 'tools.generated.d.ts must exist');
  });

  test('declarations include every v2.5 tool request/response pair', () => {
    const decls = fs.readFileSync(path.join(distRoot, 'tools.generated.d.ts'), 'utf8');
    const expected = [
      'GetProductsRequest',
      'GetProductsResponse',
      'CreateMediaBuyRequest',
      'CreateMediaBuyResponse',
      'UpdateMediaBuyRequest',
      'UpdateMediaBuyResponse',
      'SyncCreativesRequest',
      'SyncCreativesResponse',
      'ListCreativesRequest',
      'ListCreativesResponse',
      'ListCreativeFormatsRequest',
      'ListCreativeFormatsResponse',
      'GetMediaBuyDeliveryRequest',
      'GetMediaBuyDeliveryResponse',
      'ListAuthorizedPropertiesRequest',
      'ListAuthorizedPropertiesResponse',
      'ProvidePerformanceFeedbackRequest',
      'ProvidePerformanceFeedbackResponse',
      'BuildCreativeRequest',
      'BuildCreativeResponse',
      'PreviewCreativeRequest',
      'PreviewCreativeResponse',
      'GetSignalsRequest',
      'GetSignalsResponse',
      'ActivateSignalRequest',
      'ActivateSignalResponse',
    ];
    for (const name of expected) {
      assert.ok(
        new RegExp(`\\b(?:interface|type)\\s+${name}\\b`).test(decls),
        `expected ${name} declaration in tools.generated.d.ts`
      );
    }
  });

  test('package.json exports `./types/v2-5`', () => {
    const pkg = require('../../package.json');
    const exp = pkg.exports?.['./types/v2-5'];
    assert.ok(exp, 'package.json must export `./types/v2-5`');
    assert.match(exp.types, /v2-5\/index\.d\.ts$/);
  });
});
