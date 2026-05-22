const { test, describe } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');
const betaTypesPath = path.join(repoRoot, 'src/lib/types/v3-1-beta/tools.generated.ts');
const betaGeneratorPath = path.join(repoRoot, 'scripts/generate-3-1-beta-types.ts');

describe('v3.1-beta sync_accounts notification config types', () => {
  test('codegen keeps concrete sync_accounts mode interfaces', () => {
    const generatorContent = fs.readFileSync(betaGeneratorPath, 'utf8');
    const typesContent = fs.readFileSync(betaTypesPath, 'utf8');

    assert.match(generatorContent, /function tightenSyncAccountsModeTypes/);
    assert.match(typesContent, /export interface ProvisioningMode \{\n\s+brand: BrandReference;/);
    assert.match(typesContent, /export interface SettingsUpdateMode \{\n\s+account: AccountReference;/);
    assert.match(typesContent, /notification_configs\?: NotificationConfig\[\];/);
  });

  test('SyncAccountsRequest accepts account notifications but not catalog feed events', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v31-sync-accounts-types-'));
    const fixturePath = path.join(fixtureDir, 'typecheck.ts');
    const importPath = path.relative(fixtureDir, path.join(repoRoot, 'src/lib/types/v3-1-beta')).replace(/\\/g, '/');
    const modulePath = importPath.startsWith('.') ? importPath : `./${importPath}`;

    fs.writeFileSync(
      fixturePath,
      `
import type { SyncAccountsRequest } from '${modulePath}';

const provisioning: SyncAccountsRequest = {
  idempotency_key: 'provisioning-notification-config',
  accounts: [
    {
      brand: {
        domain: 'acme.example',
        brand_id: 'brand_acme',
      },
      operator: 'acme-direct',
      billing: 'advertiser',
      notification_configs: [
        {
          subscriber_id: 'creative-sync',
          url: 'https://buyer.example/webhooks/adcp/creative',
          event_types: ['creative.status_changed'],
          active: true,
        },
      ],
    },
  ],
};

const settingsUpdate: SyncAccountsRequest = {
  idempotency_key: 'settings-notification-config',
  accounts: [
    {
      account: { account_id: 'acc_acme_pinnacle' },
      notification_configs: [
        {
          subscriber_id: 'creative-sync',
          url: 'https://buyer.example/webhooks/adcp/creative',
          event_types: ['creative.purged'],
        },
      ],
    },
  ],
};

const catalogFeedEventOnAccountNotifications: SyncAccountsRequest = {
  idempotency_key: 'catalog-event-wrong-surface',
  accounts: [
    {
      account: { account_id: 'acc_acme_pinnacle' },
      notification_configs: [
        {
          subscriber_id: 'catalog-sync',
          url: 'https://buyer.example/webhooks/adcp/catalog',
          // @ts-expect-error - catalog feed events are advertised via catalog_change_feed, not sync_accounts notification_configs.
          event_types: ['product.created'],
        },
      ],
    },
  ],
};

void provisioning;
void settingsUpdate;
void catalogFeedEventOnAccountNotifications;
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
        {
          cwd: repoRoot,
          encoding: 'utf8',
          timeout: 30000,
        }
      );

      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
