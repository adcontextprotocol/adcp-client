const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');

const {
  RegistryClient,
  RegistrySync,
  InMemoryCursorStore,
  parseSseStream,
  FeedStreamUnsupportedError,
  FeedStreamCursorExpiredError,
  FeedStreamHttpError,
  FeedStreamParseError,
} = require('../../dist/lib/registry/index.js');

// ====== Shared helpers ======

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, { timeout = 2000, interval = 5 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out after ${timeout}ms`);
    await delay(interval);
  }
}

function frameText(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamFromChunks(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function collect(gen) {
  const out = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** A controllable SSE source that can push frames, close cleanly, or error (disconnect). */
function sseStream() {
  let controller;
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  let done = false;
  return {
    stream,
    push(event, data) {
      if (!done) controller.enqueue(enc.encode(frameText(event, data)));
    },
    raw(text) {
      if (!done) controller.enqueue(enc.encode(text));
    },
    close() {
      if (!done) {
        done = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    error(err) {
      if (!done) {
        done = true;
        try {
          controller.error(err);
        } catch {
          /* already closed */
        }
      }
    },
  };
}

function sseResponse(stream) {
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const AGENT = {
  url: 'https://ads.example.com',
  name: 'Example',
  type: 'sales',
  inventory_profile: {
    channels: ['ctv'],
    property_types: ['ctv_app'],
    markets: ['US'],
    categories: ['IAB-7'],
    category_taxonomy: 'iab_content_3.0',
    tags: [],
    delivery_types: ['guaranteed'],
    property_count: 1,
    publisher_count: 1,
    has_tmp: false,
  },
  match: { score: 1, matched_filters: [] },
};

function searchResponse(results) {
  return jsonResponse({ results, has_more: false, cursor: null });
}

function feedPage(events, { cursor = 'cursor-x', has_more = false, freshness } = {}) {
  const page = { events, cursor, has_more };
  if (freshness) page.freshness = freshness;
  return page;
}

function discoverEvent(url, name) {
  return {
    event_id: `evt-${url}-${name}`,
    event_type: 'agent.discovered',
    entity_type: 'agent',
    entity_id: url,
    payload: { name, type: 'sales' },
    actor: 'test',
    created_at: '2026-06-26T00:00:00.000Z',
  };
}

function authEvent(agentUrl, domain) {
  return {
    event_id: `auth-${agentUrl}-${domain}`,
    event_type: 'authorization.granted',
    entity_type: 'authorization',
    entity_id: `${agentUrl}:${domain}`,
    payload: { agent_url: agentUrl, publisher_domain: domain, authorization_type: 'full' },
    actor: 'test',
    created_at: '2026-06-26T00:00:00.000Z',
  };
}

/**
 * Install a fetch mock with separate handlers for search, the polling feed, and
 * the SSE stream. The stream's abort signal is wired to error the source so
 * stop()/idle aborts behave like a real fetch cancelling its body.
 */
function installMock({ search, poll, onConnect } = {}) {
  let streamIndex = 0;
  const streamUrls = [];
  const pollUrls = [];
  const apis = [];
  const restore = mockFetch(async (url, opts) => {
    if (url.includes('/agents/search')) {
      return (search ?? (() => searchResponse([AGENT])))(url);
    }
    if (url.includes('/registry/feed/stream')) {
      const idx = streamIndex++;
      streamUrls.push(url);
      const override = onConnect ? onConnect(idx, url) : undefined;
      if (override instanceof Response) return override;
      const api = sseStream();
      apis.push(api);
      if (opts && opts.signal) {
        const onAbort = () => api.error(new Error('aborted'));
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      return sseResponse(api.stream);
    }
    if (url.includes('/registry/feed')) {
      pollUrls.push(url);
      return (poll ?? (() => jsonResponse(feedPage([], { cursor: 'boot-0' }))))(url);
    }
    return new Response('Not found', { status: 404 });
  });
  return {
    restore,
    streamUrls,
    pollUrls,
    get streamCount() {
      return streamIndex;
    },
    api(i) {
      return apis[i];
    },
    lastApi() {
      return apis[apis.length - 1];
    },
  };
}

// ====== Tests ======

describe('parseSseStream', () => {
  test('parses a single named event', async () => {
    const events = await collect(parseSseStream(streamFromChunks([frameText('feed', { ok: 1 })])));
    assert.deepStrictEqual(events, [{ event: 'feed', data: '{"ok":1}' }]);
  });

  test('joins multiple data lines with a newline', async () => {
    const events = await collect(parseSseStream(streamFromChunks(['event: feed\ndata: a\ndata: b\n\n'])));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].data, 'a\nb');
  });

  test('ignores comment lines', async () => {
    const events = await collect(parseSseStream(streamFromChunks([': keep-alive\nevent: feed\ndata: 1\n\n'])));
    assert.deepStrictEqual(events, [{ event: 'feed', data: '1' }]);
  });

  test('reassembles a frame split across chunks', async () => {
    const events = await collect(parseSseStream(streamFromChunks(['event: fe', 'ed\ndata: {"a":', '1}\n\n'])));
    assert.deepStrictEqual(events, [{ event: 'feed', data: '{"a":1}' }]);
  });

  test('handles CRLF line endings', async () => {
    const events = await collect(parseSseStream(streamFromChunks(['event: feed\r\ndata: 1\r\n\r\n'])));
    assert.deepStrictEqual(events, [{ event: 'feed', data: '1' }]);
  });

  test('handles a CRLF split between chunks without inventing a blank line', async () => {
    const events = await collect(parseSseStream(streamFromChunks(['event: feed\r', '\ndata: 1\r', '\n\r', '\n'])));
    assert.deepStrictEqual(events, [{ event: 'feed', data: '1' }]);
  });

  test('drops an incomplete final block (no trailing blank line)', async () => {
    const events = await collect(
      parseSseStream(streamFromChunks([frameText('feed', { ok: 1 }), 'event: feed\ndata: {"part']))
    );
    assert.deepStrictEqual(events, [{ event: 'feed', data: '{"ok":1}' }]);
  });

  test('emits multiple events in order', async () => {
    const events = await collect(
      parseSseStream(streamFromChunks([frameText('heartbeat', { cursor: 'a' }) + frameText('feed', { events: [] })]))
    );
    assert.deepStrictEqual(
      events.map(e => e.event),
      ['heartbeat', 'feed']
    );
  });

  test('reassembles a large single-data-line frame delivered in many tiny chunks', async () => {
    // Guards the O(n) fragment path: a big page sent as one `data:` line split
    // into 1-byte chunks must parse to exactly one event without re-flattening.
    const payload = JSON.stringify({ events: [], cursor: 'c', has_more: false, blob: 'z'.repeat(50000) });
    const frame = `event: feed\ndata: ${payload}\n\n`;
    const enc = new TextEncoder();
    const bytes = enc.encode(frame);
    const stream = new ReadableStream({
      start(ctrl) {
        for (let i = 0; i < bytes.length; i++) ctrl.enqueue(bytes.slice(i, i + 1));
        ctrl.close();
      },
    });
    const events = await collect(parseSseStream(stream));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, 'feed');
    assert.strictEqual(events[0].data, payload);
  });

  test('fails closed when an un-dispatched event exceeds maxFrameBytes (no terminator)', async () => {
    // A hostile stream that never emits a blank line must not buffer unbounded.
    const huge = 'event: feed\ndata: ' + 'x'.repeat(5000);
    await assert.rejects(
      () => collect(parseSseStream(streamFromChunks([huge]), { maxFrameBytes: 1000 })),
      FeedStreamParseError
    );
  });

  test('fails closed on an unbounded run of data lines before a blank line', async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 500; i++) c.enqueue(enc.encode('data: aaaaaaaaaa\n'));
        // never sends the dispatching blank line
        c.close();
      },
    });
    await assert.rejects(() => collect(parseSseStream(stream, { maxFrameBytes: 1000 })), FeedStreamParseError);
  });
});

describe('RegistryClient.streamFeed', () => {
  let restore;
  afterEach(() => {
    if (restore) restore();
    restore = null;
  });

  test('requires an apiKey', () => {
    const client = new RegistryClient();
    assert.throws(() => client.streamFeed(), /apiKey is required/);
  });

  test('yields typed feed / heartbeat / error messages', async () => {
    const api = sseStream();
    restore = mockFetch(async () => sseResponse(api.stream));
    api.push('feed', feedPage([discoverEvent('https://a.example.com', 'A')], { cursor: 'c1' }));
    api.push('heartbeat', { generated_at: '2026-06-26T00:00:00Z', cursor: 'c1' });
    api.push('error', { error: 'feed_stream_error', message: 'boom' });
    api.close();

    const client = new RegistryClient({ apiKey: 'sk_test' });
    const msgs = await collect(client.streamFeed());
    assert.deepStrictEqual(
      msgs.map(m => m.type),
      ['feed', 'heartbeat', 'error']
    );
    assert.strictEqual(msgs[0].page.cursor, 'c1');
    assert.strictEqual(msgs[2].error.error, 'feed_stream_error');
  });

  test('throws FeedStreamCursorExpiredError on 410', async () => {
    restore = mockFetch(async () => jsonResponse({ error: 'cursor_expired', message: 'gone' }, 410));
    const client = new RegistryClient({ apiKey: 'sk_test' });
    await assert.rejects(() => collect(client.streamFeed()), FeedStreamCursorExpiredError);
  });

  test('throws FeedStreamUnsupportedError on 404', async () => {
    restore = mockFetch(async () => new Response('nope', { status: 404 }));
    const client = new RegistryClient({ apiKey: 'sk_test' });
    await assert.rejects(() => collect(client.streamFeed()), FeedStreamUnsupportedError);
  });

  test('throws FeedStreamUnsupportedError on a non-stream content-type', async () => {
    restore = mockFetch(async () => jsonResponse({ events: [] }));
    const client = new RegistryClient({ apiKey: 'sk_test' });
    await assert.rejects(() => collect(client.streamFeed()), FeedStreamUnsupportedError);
  });

  test('throws FeedStreamHttpError (with status) on 429 too-many-streams', async () => {
    restore = mockFetch(async () => jsonResponse({ error: 'Too many active registry feed streams' }, 429));
    const client = new RegistryClient({ apiKey: 'sk_test' });
    await assert.rejects(
      () => collect(client.streamFeed()),
      err => err instanceof FeedStreamHttpError && err.status === 429
    );
  });

  test('throws FeedStreamParseError on malformed frame data', async () => {
    const api = sseStream();
    restore = mockFetch(async () => sseResponse(api.stream));
    api.raw('event: feed\ndata: {not json\n\n');
    api.close();
    const client = new RegistryClient({ apiKey: 'sk_test' });
    await assert.rejects(() => collect(client.streamFeed()), FeedStreamParseError);
  });

  test('passes cursor and types as query params', async () => {
    let seenUrl;
    const api = sseStream();
    restore = mockFetch(async url => {
      seenUrl = url;
      api.close();
      return sseResponse(api.stream);
    });
    const client = new RegistryClient({ apiKey: 'sk_test' });
    await collect(client.streamFeed({ cursor: 'abc', types: 'authorization.*', pollIntervalSeconds: 20 }));
    assert.match(seenUrl, /\/api\/registry\/feed\/stream\?/);
    assert.match(seenUrl, /cursor=abc/);
    assert.match(seenUrl, /types=authorization/);
    assert.match(seenUrl, /poll_interval_seconds=20/);
  });
});

describe('RegistryClient.getFeed cursor expiry', () => {
  let restore;
  afterEach(() => {
    if (restore) restore();
    restore = null;
  });

  test('maps a real HTTP 410 to a recoverable cursor_expired response', async () => {
    restore = mockFetch(async () => jsonResponse({ error: 'cursor_expired', message: 'gone' }, 410));
    const client = new RegistryClient({ apiKey: 'sk_test' });
    const feed = await client.getFeed({ cursor: 'stale-cursor' });
    assert.strictEqual(feed.cursor_expired, true);
    assert.deepStrictEqual(feed.events, []);
    assert.strictEqual(feed.cursor, null);
    assert.strictEqual(feed.has_more, false);
  });

  test('still throws on other non-2xx statuses', async () => {
    restore = mockFetch(async () => new Response('boom', { status: 500 }));
    const client = new RegistryClient({ apiKey: 'sk_test' });
    await assert.rejects(() => client.getFeed({ cursor: 'c' }), /500/);
  });
});

describe('RegistrySync config validation', () => {
  test('rejects out-of-range feedPageLimit', () => {
    const client = new RegistryClient({ apiKey: 'sk_test' });
    assert.throws(() => new RegistrySync({ client, feedPageLimit: 0 }), /feedPageLimit/);
    assert.throws(() => new RegistrySync({ client, feedPageLimit: 20000 }), /feedPageLimit/);
  });

  test('rejects out-of-range streamPollIntervalSeconds', () => {
    const client = new RegistryClient({ apiKey: 'sk_test' });
    assert.throws(() => new RegistrySync({ client, streamPollIntervalSeconds: 1 }), /streamPollIntervalSeconds/);
    assert.throws(() => new RegistrySync({ client, streamPollIntervalSeconds: 120 }), /streamPollIntervalSeconds/);
  });
});

describe('RegistrySync SSE transport', () => {
  let sync;
  let mock;

  afterEach(() => {
    if (sync) sync.stop();
    if (mock) mock.restore();
    sync = null;
    mock = null;
  });

  function startSync(config = {}) {
    const client = new RegistryClient({ apiKey: 'sk_test' });
    sync = new RegistrySync({
      client,
      streamReconnectMinMs: 5,
      streamReconnectMaxMs: 20,
      ...config,
    });
    sync.on('error', () => {}); // prevent unhandled 'error' events
    return sync.start();
  }

  test('selects the stream transport by default', async () => {
    mock = installMock({});
    await startSync();
    await waitFor(() => mock.streamCount >= 1);
    assert.strictEqual(sync.getTransport(), 'stream');
  });

  test('applies feed events, advances the cursor, and exposes freshness', async () => {
    mock = installMock({});
    await startSync();
    await waitFor(() => mock.streamCount >= 1);

    mock.lastApi().push(
      'feed',
      feedPage([discoverEvent('https://new.example.com', 'New')], {
        cursor: 'feed-1',
        freshness: {
          generated_at: '2026-06-26T12:00:00.000Z',
          latest_event_created_at: '2026-06-26T11:59:47.000Z',
          lag_seconds: 13,
          retention_days: 90,
        },
      })
    );

    await waitFor(() => sync.getAgent('https://new.example.com'));
    assert.strictEqual(sync.getCursor(), 'feed-1');
    assert.strictEqual(sync.getLagSeconds(), 13);
    assert.strictEqual(sync.getFreshness().retention_days, 90);
  });

  test('cursor advances only on feed, not heartbeat', async () => {
    mock = installMock({ poll: () => jsonResponse(feedPage([], { cursor: 'boot-0' })) });
    await startSync();
    await waitFor(() => mock.streamCount >= 1);
    assert.strictEqual(sync.getCursor(), 'boot-0');

    // A heartbeat carries a cursor but must NOT advance our persisted cursor.
    mock.lastApi().push('heartbeat', {
      generated_at: '2026-06-26T12:00:00.000Z',
      cursor: 'heartbeat-cursor',
      freshness: {
        generated_at: '2026-06-26T12:00:00.000Z',
        latest_event_created_at: null,
        lag_seconds: null,
        retention_days: 90,
      },
    });

    // Freshness is observed from the heartbeat even though the cursor holds.
    await waitFor(() => sync.getFreshness() != null);
    assert.strictEqual(sync.getCursor(), 'boot-0');

    // A feed page does advance it.
    mock.lastApi().push('feed', feedPage([discoverEvent('https://x.example.com', 'X')], { cursor: 'feed-9' }));
    await waitFor(() => sync.getCursor() === 'feed-9');
  });

  test('reconnects from the last persisted cursor after disconnect', async () => {
    mock = installMock({ poll: () => jsonResponse(feedPage([], { cursor: 'boot-0' })) });
    await startSync();
    await waitFor(() => mock.streamCount >= 1);

    mock.lastApi().push('feed', feedPage([discoverEvent('https://a.example.com', 'A')], { cursor: 'feed-A' }));
    await waitFor(() => sync.getCursor() === 'feed-A');

    // Server closes the stream; the SDK reconnects from feed-A.
    mock.lastApi().close();
    await waitFor(() => mock.streamCount >= 2);
    assert.match(mock.streamUrls[1], /cursor=feed-A/);
  });

  test('cursor_expired error event triggers re-bootstrap then resumes', async () => {
    let phase = 'initial';
    mock = installMock({
      search: () =>
        phase === 'initial'
          ? searchResponse([AGENT])
          : searchResponse([{ ...AGENT, url: 'https://rebooted.example.com', name: 'Rebooted' }]),
      // The re-bootstrap drain returns a fresh cursor, proving recovery rather
      // than reuse of the expired one.
      poll: () => jsonResponse(feedPage([], { cursor: phase === 'initial' ? 'boot-0' : 'boot-1' })),
    });

    const bootstraps = [];
    await startSync();
    sync.on('bootstrap', d => bootstraps.push(d));
    await waitFor(() => mock.streamCount >= 1);
    assert.ok(sync.getAgent('https://ads.example.com'));
    assert.match(mock.streamUrls[0], /cursor=boot-0/);

    phase = 'rebooted';
    mock.lastApi().push('error', { error: 'cursor_expired', message: 'gone' });

    await waitFor(() => sync.getAgent('https://rebooted.example.com'));
    assert.strictEqual(sync.getAgent('https://ads.example.com'), undefined, 'old index cleared on re-bootstrap');
    assert.ok(bootstraps.length >= 1, 'a fresh bootstrap fired');
    // The resumed stream tails from the fresh post-bootstrap cursor, not the expired one.
    await waitFor(() => mock.streamCount >= 2);
    assert.match(mock.streamUrls[1], /cursor=boot-1/);
  });

  test('falls back to polling when the stream endpoint is unsupported (404)', async () => {
    mock = installMock({
      onConnect: () => new Response('not found', { status: 404 }),
      poll: () => jsonResponse(feedPage([], { cursor: 'boot-0' })),
    });
    const transports = [];
    await startSync({ pollIntervalMs: 20 });
    sync.on('transport', t => transports.push(t.transport));

    await waitFor(() => sync.getTransport() === 'poll');
    const pollsAfterFallback = mock.pollUrls.length;
    await waitFor(() => mock.pollUrls.length > pollsAfterFallback);
    assert.ok(mock.streamCount >= 1, 'attempted the stream first');
  });

  test('falls back to polling after repeated stream failures', async () => {
    mock = installMock({
      onConnect: () => new Response('boom', { status: 500 }),
      poll: () => jsonResponse(feedPage([], { cursor: 'boot-0' })),
    });
    await startSync({ pollIntervalMs: 20, maxStreamFailures: 2 });
    await waitFor(() => sync.getTransport() === 'poll', { timeout: 3000 });
    assert.ok(mock.streamCount >= 2, 'retried the stream before falling back');
  });

  test("'stream' mode does not fall back to polling on an unsupported endpoint", async () => {
    mock = installMock({
      onConnect: () => new Response('not found', { status: 404 }),
      poll: () => jsonResponse(feedPage([], { cursor: 'boot-0' })),
    });
    await startSync({ transport: 'stream', maxStreamFailures: 2 });
    await waitFor(() => mock.streamCount >= 3);
    assert.strictEqual(sync.getTransport(), 'stream');
    assert.strictEqual(mock.pollUrls.length, 1, 'only the bootstrap drain polled');
  });

  test('a malformed frame does not corrupt indexes; the stream reconnects', async () => {
    mock = installMock({ poll: () => jsonResponse(feedPage([], { cursor: 'boot-0' })) });
    await startSync();
    await waitFor(() => mock.streamCount >= 1);

    // Good page, then a malformed frame that drops the connection.
    mock.lastApi().push('feed', feedPage([discoverEvent('https://good1.example.com', 'Good1')], { cursor: 'feed-1' }));
    await waitFor(() => sync.getAgent('https://good1.example.com'));
    mock.lastApi().raw('event: feed\ndata: {bad json\n\n');

    // Reconnect delivers another good page; both agents present, no corruption.
    await waitFor(() => mock.streamCount >= 2);
    mock.lastApi().push('feed', feedPage([discoverEvent('https://good2.example.com', 'Good2')], { cursor: 'feed-2' }));
    await waitFor(() => sync.getAgent('https://good2.example.com'));

    assert.ok(sync.getAgent('https://good1.example.com'));
    assert.strictEqual(sync.getCursor(), 'feed-2');
    assert.strictEqual(sync.getStats().agents, 3); // bootstrap AGENT + good1 + good2
  });

  test('duplicate pages do not corrupt the authorization index', async () => {
    mock = installMock({ poll: () => jsonResponse(feedPage([], { cursor: 'boot-0' })) });
    await startSync();
    await waitFor(() => mock.streamCount >= 1);

    const page = feedPage([authEvent('https://ads.example.com', 'pub.com')], { cursor: 'feed-1' });
    mock.lastApi().push('feed', page);
    mock.lastApi().push('feed', page); // duplicate delivery
    await waitFor(() => sync.isAuthorized('https://ads.example.com', 'pub.com'));

    assert.strictEqual(sync.getAuthorizationsForDomain('pub.com').length, 1);
    assert.strictEqual(sync.getStats().authorizations, 1);
  });

  test('a partial (never-terminated) page is not applied', async () => {
    mock = installMock({ poll: () => jsonResponse(feedPage([], { cursor: 'boot-0' })) });
    await startSync();
    await waitFor(() => mock.streamCount >= 1);

    // A feed frame with no terminating blank line, then disconnect.
    const page = feedPage([discoverEvent('https://partial.example.com', 'Partial')], { cursor: 'feed-partial' });
    mock.lastApi().raw('event: feed\ndata: ' + JSON.stringify(page));
    mock.lastApi().close();

    await waitFor(() => mock.streamCount >= 2); // reconnected
    assert.strictEqual(sync.getAgent('https://partial.example.com'), undefined);
    assert.strictEqual(sync.getCursor(), 'boot-0', 'cursor not advanced by an incomplete page');
  });

  test('idle timeout reconnects a stalled stream', async () => {
    mock = installMock({ poll: () => jsonResponse(feedPage([], { cursor: 'boot-0' })) });
    await startSync({ streamIdleTimeoutMs: 40 });
    await waitFor(() => mock.streamCount >= 1);
    // No frames arrive; the idle watchdog aborts and reconnects.
    await waitFor(() => mock.streamCount >= 2, { timeout: 2000 });
  });

  test('forced poll transport never opens a stream', async () => {
    mock = installMock({ poll: () => jsonResponse(feedPage([], { cursor: 'boot-0' })) });
    await startSync({ transport: 'poll', pollIntervalMs: 20 });
    await waitFor(() => sync.getTransport() === 'poll');
    await delay(60);
    assert.strictEqual(mock.streamCount, 0);
  });

  test('does not fabricate freshness when the server omits it', async () => {
    // Neither the bootstrap poll nor the feed page carries freshness.
    mock = installMock({ poll: () => jsonResponse(feedPage([], { cursor: 'boot-0' })) });
    await startSync();
    await waitFor(() => mock.streamCount >= 1);
    mock.lastApi().push('feed', feedPage([discoverEvent('https://nf.example.com', 'NF')], { cursor: 'feed-1' }));
    await waitFor(() => sync.getAgent('https://nf.example.com'));
    assert.strictEqual(sync.getFreshness(), null);
    assert.strictEqual(sync.getLagSeconds(), null);
  });

  test('a permanent 401 is fatal: no reconnect, no polling fallback', async () => {
    mock = installMock({
      onConnect: () => jsonResponse({ error: 'unauthorized' }, 401),
      poll: () => jsonResponse(feedPage([], { cursor: 'boot-0' })),
    });
    await startSync({ pollIntervalMs: 20 });
    await waitFor(() => sync.state === 'error');
    assert.strictEqual(sync.getTransport(), null);
    const streamsAtError = mock.streamCount;
    const pollsAtError = mock.pollUrls.length;
    await delay(80);
    assert.strictEqual(mock.streamCount, streamsAtError, 'did not reconnect after a fatal error');
    assert.strictEqual(mock.pollUrls.length, pollsAtError, 'did not fall back to polling on a fatal error');
  });

  test('stop() during bootstrap is honored (not silently resumed)', async () => {
    mock = installMock({
      search: async () => {
        await delay(40); // hold the bootstrap window open
        return searchResponse([AGENT]);
      },
      poll: () => jsonResponse(feedPage([], { cursor: 'boot-0' })),
    });
    const client = new RegistryClient({ apiKey: 'sk_test' });
    sync = new RegistrySync({ client });
    sync.on('error', () => {});
    const bootstraps = [];
    sync.on('bootstrap', d => bootstraps.push(d));

    const startPromise = sync.start(); // do NOT await
    sync.stop(); // lands mid-bootstrap
    await startPromise;
    await delay(60);

    assert.strictEqual(sync.state, 'idle', 'stayed stopped');
    assert.strictEqual(sync.getTransport(), null);
    assert.strictEqual(mock.streamCount, 0, 'no stream opened after stop during bootstrap');
    assert.strictEqual(bootstraps.length, 0, 'bootstrap completion suppressed after stop');
  });

  test('persists the stream cursor and resumes from it on restart', async () => {
    const store = new InMemoryCursorStore();
    mock = installMock({ poll: () => jsonResponse(feedPage([], { cursor: 'boot-0' })) });
    const client = new RegistryClient({ apiKey: 'sk_test' });

    // First instance advances the cursor via a stream page.
    sync = new RegistrySync({ client, cursorStore: store, streamReconnectMinMs: 5, streamReconnectMaxMs: 20 });
    sync.on('error', () => {});
    await sync.start();
    await waitFor(() => mock.streamCount >= 1);
    mock.lastApi().push('feed', feedPage([discoverEvent('https://r.example.com', 'R')], { cursor: 'feed-persisted' }));
    await waitFor(() => sync.getCursor() === 'feed-persisted');
    assert.strictEqual(await store.getCursor(), 'feed-persisted', 'stream page cursor persisted to the store');
    sync.stop();

    // Second instance with the same store resumes the drain from the persisted cursor.
    const firstPollCount = mock.pollUrls.length;
    const sync2 = new RegistrySync({ client, cursorStore: store, streamReconnectMinMs: 5, streamReconnectMaxMs: 20 });
    sync2.on('error', () => {});
    await sync2.start();
    try {
      const resumeDrain = mock.pollUrls.slice(firstPollCount).find(u => !u.includes('/stream'));
      assert.ok(
        resumeDrain && resumeDrain.includes('cursor=feed-persisted'),
        'restart resumes the drain from the persisted cursor'
      );
    } finally {
      sync2.stop();
    }
  });
});
