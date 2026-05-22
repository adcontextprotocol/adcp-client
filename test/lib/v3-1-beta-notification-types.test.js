const { test, describe } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');
const betaTypesPath = path.join(repoRoot, 'src/lib/types/v3-1-beta/tools.generated.ts');
const betaGeneratorPath = path.join(repoRoot, 'scripts/generate-3-1-beta-types.ts');
const schemaLoaderPath = path.join(repoRoot, 'src/lib/validation/schema-loader.ts');
const schemasDataRoot = path.join(repoRoot, 'dist/lib/schemas-data');

const catalogNotificationTypes = [
  'product.created',
  'product.updated',
  'product.priced',
  'product.removed',
  'signal.created',
  'signal.updated',
  'signal.priced',
  'signal.removed',
  'catalog.bulk_change',
];

function extractNotificationTypeBlock(src) {
  const match = src.match(/export type NotificationType =\n([\s\S]*?);/);
  assert.ok(match, 'NotificationType union should exist');
  return match[1];
}

describe('v3.1-beta notification types', () => {
  test('sync_accounts notification_configs accept catalog change events', () => {
    const typesContent = fs.readFileSync(betaTypesPath, 'utf8');
    const block = extractNotificationTypeBlock(typesContent);

    for (const eventType of catalogNotificationTypes) {
      assert.match(block, new RegExp(`'${eventType.replace('.', '\\.')}'`), `${eventType} must be in NotificationType`);
    }

    assert.match(
      typesContent,
      /event_types: NotificationType\[\];/,
      'NotificationConfig.event_types should continue to use NotificationType'
    );
  });

  test('3.1-beta type generation preserves catalog notification widening', () => {
    const generatorContent = fs.readFileSync(betaGeneratorPath, 'utf8');

    assert.match(generatorContent, /function widenCatalogNotificationTypes/, 'generator must preserve the widening');
    for (const eventType of catalogNotificationTypes) {
      assert.match(
        generatorContent,
        new RegExp(`'${eventType.replace('.', '\\.')}'`),
        `${eventType} must be preserved by the generator`
      );
    }
  });

  test('schema validation widens the same notification enum at load time', () => {
    const loaderContent = fs.readFileSync(schemaLoaderPath, 'utf8');

    assert.match(
      loaderContent,
      /function widenCatalogNotificationEnums/,
      'schema loader must preserve runtime widening'
    );
    assert.match(
      loaderContent,
      /supportsCatalogNotificationWidening\(s\.version, file\)/,
      'runtime widening should be gated by the resolved schema version'
    );
    for (const eventType of catalogNotificationTypes) {
      assert.match(
        loaderContent,
        new RegExp(`'${eventType.replace('.', '\\.')}'`),
        `${eventType} must be accepted by runtime schema validation`
      );
    }
  });

  test('runtime schema widening is limited to 3.1 bundles', () => {
    let validation;
    let loader;
    try {
      validation = require('../../dist/lib/validation/schema-validator.js');
      loader = require('../../dist/lib/validation/schema-loader.js');
    } catch (err) {
      assert.match(err.message, /Cannot find module/, 'unexpected dist import failure');
      return;
    }

    const betaDir = path.join(schemasDataRoot, '3.1-beta.test');
    const stable31Dir = path.join(schemasDataRoot, '3.1');
    const future310Dir = path.join(schemasDataRoot, '3.10');
    const controlDir = path.join(schemasDataRoot, '9.9');
    const stable31BackupDir = path.join(schemasDataRoot, '.v31-notification-stable-backup');
    const writeFixture = dir => {
      fs.mkdirSync(path.join(dir, 'bundled', 'account'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'bundled', 'account', 'sync-accounts-request.json'),
        JSON.stringify(
          {
            $id: `/schemas/${path.basename(dir)}/bundled/account/sync-accounts-request.json`,
            type: 'object',
            properties: {
              idempotency_key: { type: 'string' },
              accounts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    account: {
                      type: 'object',
                      properties: { account_id: { type: 'string' } },
                      required: ['account_id'],
                      additionalProperties: false,
                    },
                    notification_configs: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          subscriber_id: { type: 'string' },
                          url: { type: 'string' },
                          event_types: {
                            type: 'array',
                            items: {
                              enum: ['creative.status_changed', 'creative.purged'],
                            },
                          },
                        },
                        required: ['subscriber_id', 'url', 'event_types'],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ['account', 'notification_configs'],
                  additionalProperties: false,
                },
              },
            },
            required: ['idempotency_key', 'accounts'],
            additionalProperties: false,
          },
          null,
          2
        )
      );
    };

    fs.rmSync(betaDir, { recursive: true, force: true });
    fs.rmSync(stable31BackupDir, { recursive: true, force: true });
    if (fs.existsSync(stable31Dir)) {
      fs.cpSync(stable31Dir, stable31BackupDir, { recursive: true });
    }
    fs.rmSync(stable31Dir, { recursive: true, force: true });
    fs.rmSync(future310Dir, { recursive: true, force: true });
    fs.rmSync(controlDir, { recursive: true, force: true });
    writeFixture(betaDir);
    writeFixture(stable31Dir);
    writeFixture(future310Dir);
    writeFixture(controlDir);

    try {
      const payload = {
        idempotency_key: 'catalog-webhook-1',
        accounts: [
          {
            account: { account_id: 'acc_acme_pinnacle' },
            notification_configs: [
              {
                subscriber_id: 'catalog-sync',
                url: 'https://buyer.example/webhooks/adcp/catalog',
                event_types: ['product.created', 'catalog.bulk_change'],
              },
            ],
          },
        ],
      };

      loader._resetValidationLoader();
      assert.strictEqual(validation.validateRequest('sync_accounts', payload, '3.1-beta.test').valid, true);
      assert.strictEqual(validation.validateRequest('sync_accounts', payload, '3.1.0').valid, false);
      assert.strictEqual(validation.validateRequest('sync_accounts', payload, '3.10.0').valid, false);
      assert.strictEqual(validation.validateRequest('sync_accounts', payload, '9.9.0').valid, false);
    } finally {
      loader._resetValidationLoader();
      fs.rmSync(betaDir, { recursive: true, force: true });
      fs.rmSync(stable31Dir, { recursive: true, force: true });
      fs.rmSync(future310Dir, { recursive: true, force: true });
      if (fs.existsSync(stable31BackupDir)) {
        fs.cpSync(stable31BackupDir, stable31Dir, { recursive: true });
        fs.rmSync(stable31BackupDir, { recursive: true, force: true });
      }
      fs.rmSync(controlDir, { recursive: true, force: true });
    }
  });

  test('SyncAccountsRequest carries NotificationType through settings-update mode', () => {
    const fixturePath = path.join(repoRoot, '.context', 'v31-notification-typecheck.ts');
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(
      fixturePath,
      `
import type { SyncAccountsRequest } from '../src/lib/types/v3-1-beta';

const ok: SyncAccountsRequest = {
  idempotency_key: 'catalog-webhook-1',
  accounts: [
    {
      account: { account_id: 'acc_acme_pinnacle' },
      notification_configs: [
        {
          subscriber_id: 'catalog-sync',
          url: 'https://buyer.example/webhooks/adcp/catalog',
          event_types: ['product.created', 'catalog.bulk_change'],
          active: true,
        },
      ],
    },
  ],
};

const badEvent: SyncAccountsRequest = {
  idempotency_key: 'catalog-webhook-2',
  accounts: [
    {
      account: { account_id: 'acc_acme_pinnacle' },
      notification_configs: [
        {
          subscriber_id: 'catalog-sync',
          url: 'https://buyer.example/webhooks/adcp/catalog',
          // @ts-expect-error - unknown catalog notification events are rejected.
          event_types: ['not.a.real.event'],
        },
      ],
    },
  ],
};

void ok;
void badEvent;
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
        { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 }
      );
      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    } finally {
      fs.rmSync(fixturePath, { force: true });
    }
  });
});
