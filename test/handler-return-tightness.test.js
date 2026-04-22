/**
 * Handler Return Type Tightness Test
 *
 * Guards against regression of issue #727 (B): handler return types in
 * `create-adcp-server.ts` must be tight enough that `tsc` rejects sparse
 * returns like `{ rights_id, status: 'acquired' }` against
 * `AcquireRightsResponse`.
 *
 * The runtime suite cannot catch a reintroduced compile-time escape hatch,
 * so this test guards the two levers that make tightness hold:
 *
 *   1. `AdcpToolMap['acquire_rights' | 'get_rights' | 'get_brand_identity']['result']`
 *      must not be `Record<string, unknown>` — those slots are now typed with
 *      the generated success types.
 *   2. `DomainHandler`'s return union must not contain `Record<string, unknown>`.
 *      The general escape hatch was removed so sparse handler returns fail tsc.
 */

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert');

const SERVER_PATH = path.join(__dirname, '../src/lib/server/create-adcp-server.ts');

describe('handler return type tightness (issue #727 B)', () => {
  test('AdcpToolMap brand-rights slots are not `Record<string, unknown>`', () => {
    const src = fs.readFileSync(SERVER_PATH, 'utf8');
    const looseTools = ['acquire_rights', 'get_rights', 'get_brand_identity'].filter(tool => {
      const pattern = new RegExp(`^\\s*${tool}:\\s*\\{[^}]*result:\\s*Record<string,\\s*unknown>`, 'm');
      return pattern.test(src);
    });
    assert.deepStrictEqual(
      looseTools,
      [],
      `Re-tighten these tools in AdcpToolMap: ${looseTools.join(', ')}. ` +
        `They should reference generated success types, not Record<string, unknown>.`
    );
  });

  test('DomainHandler return union does not include `Record<string, unknown>`', () => {
    const src = fs.readFileSync(SERVER_PATH, 'utf8');
    const match = src.match(/type DomainHandler<[^>]+>\s*=\s*\([^)]*\)\s*=>\s*Promise<([^;]+)>;/m);
    assert.ok(match, 'Could not locate DomainHandler type definition');
    const returnUnion = match[1];
    assert.ok(
      !/Record<string,\s*unknown>/.test(returnUnion),
      `DomainHandler return union must not include \`Record<string, unknown>\`. ` +
        `That escape hatch lets sparse returns pass tsc. Found: ${returnUnion.trim()}`
    );
  });
});
