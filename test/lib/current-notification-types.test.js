const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');

test('current SyncAccountsRequest accepts account and wholesale-feed notifications', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-sync-accounts-types-'));
  const fixturePath = path.join(fixtureDir, 'typecheck.ts');
  const importPath = path.relative(fixtureDir, path.join(repoRoot, 'dist/lib/types')).replace(/\\/g, '/');
  const modulePath = importPath.startsWith('.') ? importPath : `./${importPath}`;
  const wholesaleImportPath = path
    .relative(fixtureDir, path.join(repoRoot, 'dist/lib/wholesale-feed-sync'))
    .replace(/\\/g, '/');
  const wholesaleModulePath = wholesaleImportPath.startsWith('.') ? wholesaleImportPath : `./${wholesaleImportPath}`;

  fs.writeFileSync(
    fixturePath,
    `
import type { GetProductsResponse, SyncAccountsRequest } from '${modulePath}';
import type {
  LegacyWholesaleFeedEvent,
  LegacyWholesaleFeedWebhook,
  LegacyWholesaleProduct,
} from '${wholesaleModulePath}';

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;
type _LegacyProductMatchesGetProducts = AssertTrue<
  LegacyWholesaleProduct extends NonNullable<GetProductsResponse['products']>[number] ? true : false
>;
type _CanonicalProductIsNotSupported = AssertNever<
  Extract<LegacyWholesaleFeedEvent, { payload: { canonical_product: unknown } }>
>;
type _CanonicalPricingIsNotSupported = AssertNever<
  Extract<LegacyWholesaleFeedEvent, { payload: { canonical_pricing_options: unknown } }>
>;
type _NonProductViewIsForbidden = AssertNever<
  Extract<
    LegacyWholesaleFeedWebhook,
    { notification_type: 'signal.updated'; product_payload_view: 'legacy' }
  >
>;

const legacyView: LegacyWholesaleFeedWebhook['product_payload_view'] = 'legacy';
// @ts-expect-error This mirror does not implement canonical list_products payloads.
const canonicalView: LegacyWholesaleFeedWebhook['product_payload_view'] = 'canonical';

const provisioning: SyncAccountsRequest = {
  idempotency_key: 'provisioning-notification-config',
  accounts: [{
    brand: { domain: 'acme.example', brand_id: 'brand_acme' },
    operator: 'acme-direct',
    billing: 'advertiser',
    notification_configs: [{
      subscriber_id: 'creative-sync',
      url: 'https://buyer.example/webhooks/adcp/creative',
      event_types: ['creative.status_changed'],
      active: true,
    }],
  }],
};

const settingsUpdate: SyncAccountsRequest = {
  idempotency_key: 'settings-notification-config',
  accounts: [{
    account: { account_id: 'acc_acme_pinnacle' },
    notification_configs: [{
      subscriber_id: 'wholesale-feed-sync',
      url: 'https://buyer.example/webhooks/adcp/wholesale-feed',
      event_types: [
        'product.created', 'product.updated', 'product.priced', 'product.removed',
        'signal.created', 'signal.updated', 'signal.priced', 'signal.removed',
        'wholesale_feed.bulk_change',
      ],
      product_payload_view: 'legacy',
      active: true,
    }],
  }],
};

void provisioning;
void settingsUpdate;
void legacyView;
void canonicalView;
`
  );

  try {
    const result = spawnSync(
      'npx',
      [
        'tsc',
        '--noEmit',
        '--strict',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--skipLibCheck',
        fixturePath,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 30000 }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
