// Tests for the publishStatusChange event bus.

process.env.NODE_ENV = 'test';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
  publishStatusChange,
  setStatusChangeBus,
  createInMemoryStatusChangeBus,
} = require('../dist/lib/server/decisioning/status-changes');

describe('publishStatusChange + StatusChangeBus', () => {
  let bus;
  let prevBus;

  beforeEach(() => {
    bus = createInMemoryStatusChangeBus();
    prevBus = setStatusChangeBus(bus);
  });

  it('publishStatusChange writes the event to the active bus', () => {
    publishStatusChange({
      account_id: 'acc_1',
      resource_type: 'media_buy',
      resource_id: 'mb_42',
      payload: { status: 'active', activated_at: '2026-04-01T00:00:00Z' },
    });

    const recent = bus.recent();
    assert.strictEqual(recent.length, 1);
    const evt = recent[0];
    assert.strictEqual(evt.account_id, 'acc_1');
    assert.strictEqual(evt.resource_type, 'media_buy');
    assert.strictEqual(evt.resource_id, 'mb_42');
    assert.strictEqual(evt.resource_uri, 'adcp://acc_1/media_buy/mb_42');
    assert.deepStrictEqual(evt.payload, { status: 'active', activated_at: '2026-04-01T00:00:00Z' });
    assert.ok(typeof evt.at === 'string', 'at is auto-filled with ISO timestamp');

    setStatusChangeBus(prevBus);
  });

  it('subscribers receive published events', async () => {
    const received = [];
    const unsubscribe = bus.subscribe(evt => {
      received.push(evt);
    });

    publishStatusChange({
      account_id: 'acc_1',
      resource_type: 'creative',
      resource_id: 'cr_5',
      payload: { status: 'approved' },
    });
    publishStatusChange({
      account_id: 'acc_1',
      resource_type: 'creative',
      resource_id: 'cr_6',
      payload: { status: 'rejected', reason: 'brand-suitability' },
    });

    assert.strictEqual(received.length, 2);
    assert.strictEqual(received[0].resource_id, 'cr_5');
    assert.strictEqual(received[1].resource_id, 'cr_6');

    unsubscribe();
    publishStatusChange({
      account_id: 'acc_1',
      resource_type: 'creative',
      resource_id: 'cr_7',
      payload: { status: 'approved' },
    });
    assert.strictEqual(received.length, 2, 'unsubscribed listener stops receiving');

    setStatusChangeBus(prevBus);
  });

  it('one bad listener does not break delivery to others', () => {
    const received = [];
    bus.subscribe(() => {
      throw new Error('listener intentionally throws');
    });
    bus.subscribe(evt => {
      received.push(evt);
    });

    // Suppress the warning log for this test
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      publishStatusChange({
        account_id: 'acc_1',
        resource_type: 'audience',
        resource_id: 'aud_99',
        payload: { status: 'matched' },
      });
    } finally {
      console.warn = origWarn;
    }

    assert.strictEqual(received.length, 1, 'second listener still received the event');
    setStatusChangeBus(prevBus);
  });

  it('recent() respects the configured limit (FIFO eviction)', () => {
    const smallBus = createInMemoryStatusChangeBus({ recentLimit: 3 });
    setStatusChangeBus(smallBus);

    for (let i = 0; i < 5; i++) {
      publishStatusChange({
        account_id: 'acc_1',
        resource_type: 'media_buy',
        resource_id: `mb_${i}`,
        payload: { status: 'active' },
      });
    }

    const recent = smallBus.recent();
    assert.strictEqual(recent.length, 3);
    assert.strictEqual(recent[0].resource_id, 'mb_2');
    assert.strictEqual(recent[2].resource_id, 'mb_4');

    setStatusChangeBus(prevBus);
  });
});
