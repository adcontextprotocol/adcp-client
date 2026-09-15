const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const root = require('../../dist/lib/index.js');
const server = require('../../dist/lib/server/index.js');
const mediaBuy = require('../../dist/lib/media-buy/index.js');
const { getSchemaDocumentByRef, getSchemaValidatorByRef } = require('../../dist/lib/validation/schema-loader.js');

test('public targeting helpers agree across barrels and ignore every unsafe clear key', () => {
  for (const name of ['resolveTargetingInput', 'applyTargetingInput', 'hasTargetingClears']) {
    assert.equal(root[name], server[name]);
    assert.equal(root[name], mediaBuy[name]);
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const input = JSON.parse(`{"${key}":null}`);
    assert.equal(root.hasTargetingClears(input), false, key);
    assert.equal(root.resolveTargetingInput(input), undefined, key);
    assert.equal(root.applyTargetingInput(undefined, input), undefined, key);
  }
  const input = Object.assign(Object.create(null), { language: ['en'], geo_countries: null });
  assert.deepEqual(root.resolveTargetingInput(input), { language: ['en'] });
  assert.deepEqual(root.applyTargetingInput(undefined, input), { language: ['en'] });
});

for (const backend of ['memory', 'postgres']) {
  test(
    `targeting persistence and readback (${backend})`,
    { skip: backend === 'postgres' && !process.env.DATABASE_URL ? 'DATABASE_URL not set' : false },
    async t => {
      let state = new server.InMemoryStateStore();
      if (backend === 'postgres') {
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        const tableName = `targeting_${randomUUID().replaceAll('-', '')}`;
        t.after(async () => {
          try {
            await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
          } finally {
            await pool.end();
          }
        });
        await pool.query(server.getAdcpStateMigration(tableName));
        state = new server.PostgresStateStore(pool, { tableName });
      }
      const store = server.createMediaBuyStore({ store: state });
      // Construct a fresh wrapper for every read so PostgreSQL must reconstruct
      // effective state from JSONB rather than echoing an in-memory reference.
      const read = async (id, account = 'account-a') => {
        const fresh = server.createMediaBuyStore({ store: state });
        return (
          await fresh.backfill(account, {
            media_buys: [{ media_buy_id: id, packages: [{ package_id: 'package-1' }] }],
          })
        ).media_buys[0].packages[0];
      };
      const validate = getSchemaValidatorByRef('core/targeting.json');
      const dimensions = Object.keys(getSchemaDocumentByRef('core/targeting.json').schema.properties);
      for (const dimension of dimensions) {
        const keep = dimension === 'geo_countries' ? { language: ['en'] } : { geo_countries: ['US'] };
        const overlay = { ...keep, [dimension]: null };
        const id = `create-${dimension}`;
        await store.persistFromCreate(
          'account-a',
          { packages: [{ buyer_ref: 'buyer-1', targeting_overlay: overlay }] },
          { media_buy_id: id, packages: [{ buyer_ref: 'buyer-1', package_id: 'package-1' }] }
        );
        assert.deepEqual((await read(id)).targeting_overlay, keep, dimension);
        assert.equal(validate((await read(id)).targeting_overlay), true, dimension);
        assert.equal((await read(id, 'account-b')).targeting_overlay, undefined, 'account isolation');
        await store.mergeFromUpdate('account-a', `new-${dimension}`, {
          new_packages: [{ package_id: 'package-1', targeting_overlay: overlay }],
        });
        assert.deepEqual((await read(`new-${dimension}`)).targeting_overlay, keep, dimension);
      }

      const id = 'update-semantics';
      const keep = { language: ['en'], geo_countries: ['US'] };
      await store.mergeFromUpdate('account-a', id, {
        new_packages: [{ package_id: 'package-1', targeting_overlay: keep }],
      });
      for (const patch of [{}, { targeting_overlay: undefined }, { targeting_overlay: {} }]) {
        await store.mergeFromUpdate('account-a', id, { packages: [{ package_id: 'package-1', ...patch }] });
        assert.deepEqual((await read(id)).targeting_overlay, keep);
      }
      await store.mergeFromUpdate('account-a', id, {
        packages: [{ package_id: 'package-1', targeting_overlay: { language: null, geo_countries: undefined } }],
      });
      assert.deepEqual((await read(id)).targeting_overlay, { geo_countries: ['US'] });
      await store.mergeFromUpdate('account-a', id, {
        packages: [{ package_id: 'package-1', targeting_overlay: { geo_countries: null } }],
      });
      assert.equal(Object.hasOwn(await read(id), 'targeting_overlay'), false);
      await store.mergeFromUpdate('account-a', id, {
        packages: [{ package_id: 'package-1', targeting_overlay: keep }],
      });
      await store.mergeFromUpdate('account-a', id, {
        packages: [{ package_id: 'package-1', targeting_overlay: null }],
      });
      assert.equal(Object.hasOwn(await read(id), 'targeting_overlay'), false);

      const hostile = JSON.parse(
        '{"__proto__":{"language":["xx"]},"constructor":null,"language":null,"geo_countries":["US"]}'
      );
      await store.mergeFromUpdate('account-a', id, {
        packages: [{ package_id: 'package-1', targeting_overlay: hostile }],
      });
      assert.deepEqual((await read(id)).targeting_overlay, { geo_countries: ['US'] });
      assert.equal({}.language, undefined);
      const supplied = {
        media_buy_id: id,
        packages: [{ package_id: 'package-1', targeting_overlay: { language: ['fr'] } }],
      };
      await store.backfill('account-a', { media_buys: [supplied] });
      assert.deepEqual(supplied.packages[0].targeting_overlay, { language: ['fr'] }, 'seller echo takes precedence');
    }
  );
}
