const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createKeyedAccountStore,
  pgKeyedAccountBackend,
  redisKeyedAccountBackend,
  getKeyedAccountMigration,
} = require('../../dist/lib/server/index.js');
const postgresUrl = process.env.ADCP_TEST_KEYED_ACCOUNT_POSTGRES_URL;
const redisUrl = process.env.ADCP_TEST_KEYED_ACCOUNT_REDIS_URL;
const ctx = { authInfo: { credential: { kind: 'api_key', key_id: 'live-backend-caller' } } };
const entry = {
  brand: { domain: 'backend.example' },
  operator: 'buyer.example',
  billing: 'agent',
  payment_terms: 'net_60',
};
const buildAccount = (ref, { accountId }) => ({
  id: accountId,
  name: 'Backend fixture',
  status: 'active',
  billing: { invoicedTo: 'agent' },
  payment_terms: ref.payment_terms,
  ctx_metadata: {},
});
async function exercise(backend, namespace) {
  const create = () => createKeyedAccountStore({ backend, namespace, buildAccount });
  const results = await Promise.all([create().upsert([entry], ctx), create().upsert([entry], ctx)]);
  assert.equal(results[0][0].account_id, results[1][0].account_id);
  assert.deepEqual(results.map(r => r[0].action).sort(), ['created', 'unchanged']);
  const accountStore = create();
  const second = { ...entry, brand: { domain: 'second-backend.example' } };
  await accountStore.upsert([second], ctx);
  assert.equal((await create().list({}, ctx)).items.length, 2);
  const scope = JSON.stringify([namespace, 'api_key:live-backend-caller']);
  const before = await backend.load(scope);
  await accountStore.upsert([{ ...entry, payment_terms: 'net_30' }], ctx);
  assert.equal(await backend.compareAndSwap(scope, before.version, []), false);
  assert.equal((await create().resolve(entry, ctx)).payment_terms, 'net_30');
  assert.equal((await create().list({}, ctx)).items.length, 2);
}
test(
  'PostgreSQL keyed accounts use real atomic CAS and survive store reconstruction',
  { skip: !postgresUrl },
  async t => {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: postgresUrl });
    const tableName = `account_test_${process.pid}`;
    await pool.query(getKeyedAccountMigration({ tableName }));
    t.after(async () => {
      await pool.query(`DROP TABLE "${tableName}"`);
      await pool.end();
    });
    await exercise(pgKeyedAccountBackend(pool, { tableName }), 'postgres-test');
  }
);
test('Redis keyed accounts execute real Lua CAS without expiration', { skip: !redisUrl }, async t => {
  const { createClient } = require('redis');
  const client = createClient({ url: redisUrl });
  await client.connect();
  const keyPrefix = `account_test_${process.pid}:`;
  const namespace = 'redis-test';
  const key = keyPrefix + JSON.stringify([namespace, 'api_key:live-backend-caller']);
  t.after(async () => {
    await client.del(key);
    await client.quit();
  });
  await exercise(redisKeyedAccountBackend(client, { keyPrefix }), namespace);
  assert.equal(await client.ttl(key), -1);
});
