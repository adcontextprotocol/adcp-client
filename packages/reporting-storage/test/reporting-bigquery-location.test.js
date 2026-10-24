const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createBigQueryReportingWarehouseSinkV1 } = require('@adcp/reporting-storage/bigquery');

function harness(getMetadata, extra = {}) {
  const reachedWarehouse = new Error('warehouse work started');
  let queries = 0;
  const sink = createBigQueryReportingWarehouseSinkV1({
    name: 'location_discovery',
    datasetId: 'reporting',
    rowsTableId: 'rows',
    revisionsTableId: 'revisions',
    store: {},
    db: {
      async query() {
        queries += 1;
        throw reachedWarehouse;
      },
    },
    bigquery: { dataset: () => ({ getMetadata }) },
    ...extra,
  });
  return { sink, reachedWarehouse, queries: () => queries };
}

test('discovers location once before warehouse work and caches it across runs', async () => {
  let reads = 0;
  const { sink, reachedWarehouse, queries } = harness(async () => {
    reads += 1;
    assert.equal(queries(), 0);
    return [{ location: 'us-central1' }];
  });
  assert.equal(reads, 0, 'construction does not start background work');
  await assert.rejects(sink.runOnce(), error => error === reachedWarehouse);
  await assert.rejects(sink.runOnce(), error => error === reachedWarehouse);
  assert.equal(reads, 1);
});

test('explicit location supports wrappers without dataset metadata access', async () => {
  const { sink, reachedWarehouse } = harness(undefined, { location: 'us-central1' });
  await assert.rejects(sink.runOnce(), error => error === reachedWarehouse);
});

for (const metadata of [undefined, [], [{}], [{ location: '' }], [{ location: ' ' }], [{ location: 42 }]]) {
  test(`refuses unusable dataset location ${JSON.stringify(metadata)} before warehouse work`, async () => {
    const { sink, queries } = harness(async () => metadata);
    await assert.rejects(sink.runOnce(), /set the warehouse sink option location explicitly/);
    assert.equal(queries(), 0);
  });
}

test('missing metadata access names the location option before warehouse work', async () => {
  const { sink, queries } = harness(undefined);
  await assert.rejects(sink.runOnce(), error => {
    assert.match(error.message, /bigquery.datasets.get/);
    assert.match(error.message, /location explicitly/);
    assert.match(error.cause.message, /getMetadata/);
    return true;
  });
  assert.equal(queries(), 0);
});

test('a metadata lookup failure preserves its cause and can be retried', async () => {
  const denied = Object.assign(new Error('Access denied'), { code: 403 });
  let reads = 0;
  const { sink, reachedWarehouse, queries } = harness(async () => {
    reads += 1;
    if (reads === 1) throw denied;
    return [{ location: 'us-central1' }];
  });
  await assert.rejects(sink.runOnce(), error => {
    assert.match(error.message, /bigquery.datasets.get/);
    assert.equal(error.cause, denied);
    return true;
  });
  assert.equal(queries(), 0);
  await assert.rejects(sink.runOnce(), error => error === reachedWarehouse);
  assert.equal(reads, 2);
});

test('overlapping runs share an in-flight metadata lookup', async () => {
  let resolve;
  let reads = 0;
  const { sink, reachedWarehouse, queries } = harness(() => {
    reads += 1;
    return new Promise(done => {
      resolve = done;
    });
  });
  const first = assert.rejects(sink.runOnce(), error => error === reachedWarehouse);
  const second = assert.rejects(sink.runOnce(), error => error === reachedWarehouse);
  assert.equal(reads, 1);
  assert.equal(queries(), 0);
  resolve([{ location: 'us-central1' }]);
  await Promise.all([first, second]);
});

test('a hung lookup is bounded by the load deadline and a later run retries discovery', async () => {
  let reads = 0;
  const { sink, reachedWarehouse, queries } = harness(
    () => {
      reads += 1;
      return reads === 1 ? new Promise(() => {}) : Promise.resolve([{ location: 'us-central1' }]);
    },
    { loadTimeoutMilliseconds: 1_000 }
  );
  await assert.rejects(sink.runOnce(), /location/);
  assert.equal(queries(), 0);
  await assert.rejects(sink.runOnce(), error => error === reachedWarehouse);
  assert.equal(reads, 2);
});

test('aborting one run does not cancel another run sharing the lookup', async () => {
  let resolve;
  let reads = 0;
  const { sink, reachedWarehouse, queries } = harness(() => {
    reads += 1;
    return new Promise(done => {
      resolve = done;
    });
  });
  const controller = new AbortController();
  const reason = new Error('cancelled');
  const first = assert.rejects(sink.runOnce({ signal: controller.signal }), error => error === reason);
  const second = assert.rejects(sink.runOnce(), error => error === reachedWarehouse);
  controller.abort(reason);
  await first;
  assert.equal(queries(), 0);
  resolve([{ location: 'us-central1' }]);
  await second;
  assert.equal(reads, 1);
});

test('an already aborted run does not request dataset metadata', async () => {
  let reads = 0;
  const { sink, queries } = harness(async () => {
    reads += 1;
    return [{ location: 'US' }];
  });
  const reason = new Error('cancelled');
  await assert.rejects(sink.runOnce({ signal: AbortSignal.abort(reason) }), error => error === reason);
  assert.equal(reads, 0);
  assert.equal(queries(), 0);
});
