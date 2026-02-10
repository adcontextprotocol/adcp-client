const { test, describe } = require('node:test');
const assert = require('node:assert');

const { paginate, paginatePages } = require('../../dist/lib/utils/pagination.js');

function makePage(items, hasMore, cursor) {
  return {
    products: items,
    pagination: { has_more: hasMore, cursor, total_count: undefined },
  };
}

const getItems = res => res.products ?? [];

describe('paginate', () => {
  test('single page with has_more false', async () => {
    const items = [{ id: '1' }, { id: '2' }];
    const fetchPage = async () => makePage(items, false, undefined);

    const result = await paginate(fetchPage, getItems);
    assert.deepStrictEqual(result, items);
  });

  test('chains cursor across multiple pages', async () => {
    const pages = [
      makePage([{ id: '1' }], true, 'cursor_a'),
      makePage([{ id: '2' }], true, 'cursor_b'),
      makePage([{ id: '3' }], false, undefined),
    ];
    let callIndex = 0;
    const cursorsReceived = [];

    const fetchPage = async pagination => {
      cursorsReceived.push(pagination?.cursor);
      return pages[callIndex++];
    };

    const result = await paginate(fetchPage, getItems);

    assert.deepStrictEqual(result, [{ id: '1' }, { id: '2' }, { id: '3' }]);
    assert.deepStrictEqual(cursorsReceived, [undefined, 'cursor_a', 'cursor_b']);
  });

  test('stops at maxItems limit', async () => {
    const pages = [
      makePage([{ id: '1' }, { id: '2' }, { id: '3' }], true, 'next'),
      makePage([{ id: '4' }, { id: '5' }], false, undefined),
    ];
    let callIndex = 0;
    const fetchPage = async () => pages[callIndex++];

    const result = await paginate(fetchPage, getItems, { maxItems: 4 });

    assert.strictEqual(result.length, 4);
    assert.deepStrictEqual(result, [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }]);
  });

  test('stops at maxPages limit', async () => {
    let callCount = 0;
    const fetchPage = async () => {
      callCount++;
      return makePage([{ id: String(callCount) }], true, `cursor_${callCount}`);
    };

    const result = await paginate(fetchPage, getItems, { maxPages: 3 });

    assert.strictEqual(callCount, 3);
    assert.strictEqual(result.length, 3);
  });

  test('handles response without pagination field', async () => {
    const fetchPage = async () => ({ products: [{ id: '1' }] });
    const result = await paginate(fetchPage, getItems);

    assert.deepStrictEqual(result, [{ id: '1' }]);
  });

  test('handles empty first page', async () => {
    const fetchPage = async () => makePage([], false, undefined);
    const result = await paginate(fetchPage, getItems);

    assert.deepStrictEqual(result, []);
  });

  test('passes pageSize as max_results', async () => {
    let receivedPagination;
    const fetchPage = async pagination => {
      receivedPagination = pagination;
      return makePage([{ id: '1' }], false, undefined);
    };

    await paginate(fetchPage, getItems, { pageSize: 25 });

    assert.strictEqual(receivedPagination.max_results, 25);
  });
});

describe('paginatePages', () => {
  test('yields each page as a separate response', async () => {
    const pages = [
      makePage([{ id: '1' }], true, 'cursor_a'),
      makePage([{ id: '2' }], true, 'cursor_b'),
      makePage([{ id: '3' }], false, undefined),
    ];
    let callIndex = 0;
    const fetchPage = async () => pages[callIndex++];

    const yielded = [];
    for await (const page of paginatePages(fetchPage)) {
      yielded.push(page);
    }

    assert.strictEqual(yielded.length, 3);
    assert.deepStrictEqual(yielded[0].products, [{ id: '1' }]);
    assert.deepStrictEqual(yielded[2].products, [{ id: '3' }]);
  });

  test('stops at maxPages limit', async () => {
    let callCount = 0;
    const fetchPage = async () => {
      callCount++;
      return makePage([{ id: String(callCount) }], true, `c${callCount}`);
    };

    const yielded = [];
    for await (const page of paginatePages(fetchPage, { maxPages: 2 })) {
      yielded.push(page);
    }

    assert.strictEqual(yielded.length, 2);
  });

  test('passes pageSize as max_results', async () => {
    const received = [];
    const fetchPage = async pagination => {
      received.push(pagination);
      return makePage([], false, undefined);
    };

    // eslint-disable-next-line no-unused-vars
    for await (const _ of paginatePages(fetchPage, { pageSize: 10 })) {
      // consume
    }

    assert.strictEqual(received[0].max_results, 10);
  });
});
