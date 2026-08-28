const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { executeStoryboardTask } = require('../../dist/lib/testing');

describe('executeStoryboardTask error normalization', () => {
  test('treats terminal failed AdCP payloads as failed task results', async () => {
    const result = await executeStoryboardTask(
      {
        executeTask: async () => ({
          data: {
            status: 'failed',
            errors: [{ code: 'INVALID_REQUEST', message: 'bad package' }],
          },
        }),
      },
      'custom_tool',
      {}
    );

    assert.equal(result.success, false);
    assert.equal(result.adcp_error.code, 'INVALID_REQUEST');
    assert.equal(result.error, 'bad package');
    assert.deepEqual(result.data.errors, [{ code: 'INVALID_REQUEST', message: 'bad package' }]);
  });

  test('preserves top-level adcp_error envelopes for storyboard validators', async () => {
    const result = await executeStoryboardTask(
      {
        executeTask: async () => ({
          adcp_error: { code: 'MEDIA_BUY_NOT_FOUND', message: 'missing buy', recovery: 'correctable' },
        }),
      },
      'custom_tool',
      {}
    );

    assert.equal(result.success, false);
    assert.equal(result.adcp_error.code, 'MEDIA_BUY_NOT_FOUND');
    assert.deepEqual(result.data, {
      adcp_error: { code: 'MEDIA_BUY_NOT_FOUND', message: 'missing buy', recovery: 'correctable' },
    });
  });

  test('does not promote submitted advisory errors to terminal adcp_error', async () => {
    const result = await executeStoryboardTask(
      {
        executeTask: async () => ({
          success: true,
          data: {
            status: 'submitted',
            task_id: 'task_1',
            errors: [{ code: 'GOVERNANCE_OBSERVATION', message: 'queued with advisory' }],
          },
        }),
      },
      'create_media_buy',
      {}
    );

    assert.equal(result.success, true);
    assert.equal(result.adcp_error, undefined);
    assert.deepEqual(result.data.errors, [{ code: 'GOVERNANCE_OBSERVATION', message: 'queued with advisory' }]);
  });
});

describe('executeStoryboardTask media-buy compatibility retries', () => {
  test('reuses one generated idempotency key across rate-limit retries', async () => {
    const calls = [];
    let attempt = 0;
    const coordinator = {
      requestProposals: async request => {
        calls.push(request);
        if (attempt++ === 0) throw new Error('rate limit exceeded');
        return { success: true, status: 'completed', data: { proposals: [] } };
      },
    };
    const result = await executeStoryboardTask(
      { negotiateMediaBuyLifecycle: async () => coordinator },
      'request_proposals',
      { brief: 'stable retry' },
      { mediaBuyLifecycleCompatibility: { principalScope: 'storyboard-buyer' } }
    );

    assert.equal(result.success, true);
    assert.equal(calls.length, 2);
    assert.match(calls[0].idempotency_key, /^[A-Za-z0-9_.:-]{16,255}$/);
    assert.equal(calls[1].idempotency_key, calls[0].idempotency_key);
  });

  test('compatibility mode preserves an explicit idempotency-key omission probe', async () => {
    const calls = [];
    const coordinator = {
      requestProposals: async (request, _inputHandler, options) => {
        calls.push({ request, options });
        return { success: false, status: 'failed', error: 'idempotency_key is required' };
      },
    };

    await executeStoryboardTask(
      { negotiateMediaBuyLifecycle: async () => coordinator },
      'request_proposals',
      { brief: 'unkeyed compliance probe' },
      {
        mediaBuyLifecycleCompatibility: { principalScope: 'storyboard-buyer' },
        skipIdempotencyAutoInject: true,
      }
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.idempotency_key, undefined);
    assert.equal(calls[0].options.skipIdempotencyAutoInject, true);
  });

  test('bounds compatibility coordinators cached per client', async () => {
    let negotiations = 0;
    let disposals = 0;
    const client = {
      negotiateMediaBuyLifecycle: async () => {
        negotiations += 1;
        const negotiation = negotiations;
        return {
          listProducts: async () => ({ success: true, data: { products: [] } }),
          dispose: () => {
            disposals += 1;
            if (negotiation === 1) throw new Error('simulated dispose failure');
          },
        };
      },
    };
    for (let index = 0; index < 40; index += 1) {
      await executeStoryboardTask(
        client,
        'list_products',
        {},
        {
          mediaBuyLifecycleCompatibility: { principalScope: `storyboard-buyer-${index}` },
        }
      );
    }
    await executeStoryboardTask(
      client,
      'list_products',
      {},
      {
        mediaBuyLifecycleCompatibility: { principalScope: 'storyboard-buyer-0' },
      }
    );

    assert.equal(negotiations, 41, 'the oldest coordinator should be evicted after the bounded cache fills');
    assert.equal(disposals, 9, 'every evicted coordinator should release its task listeners and timers');
  });

  test('rejects a 33rd concurrent compatibility partition before negotiation, then admits it after release', async () => {
    const gates = new Map();
    let active = 0;
    let negotiations = 0;
    let disposals = 0;
    let disposedWhileActive = 0;
    const client = {
      negotiateMediaBuyLifecycle: async options => {
        negotiations += 1;
        let coordinatorActive = 0;
        let release;
        const gate = new Promise(resolve => {
          release = resolve;
        });
        gates.set(options.principalScope, release);
        return {
          listProducts: async () => {
            active += 1;
            coordinatorActive += 1;
            try {
              await gate;
              return { success: true, data: { products: [] } };
            } finally {
              active -= 1;
              coordinatorActive -= 1;
            }
          },
          dispose: () => {
            disposals += 1;
            if (coordinatorActive > 0) disposedWhileActive += 1;
          },
        };
      },
    };

    const pending = Array.from({ length: 32 }, (_, index) =>
      executeStoryboardTask(
        client,
        'list_products',
        {},
        {
          mediaBuyLifecycleCompatibility: { principalScope: `concurrent-partition-${index}` },
        }
      )
    );
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(negotiations, 32);
    assert.equal(active, 32);
    await assert.rejects(
      executeStoryboardTask(
        client,
        'list_products',
        {},
        { mediaBuyLifecycleCompatibility: { principalScope: 'concurrent-partition-32' } }
      ),
      error =>
        error?.name === 'ConfigurationError' &&
        error?.code === 'CONFIGURATION_ERROR' &&
        /32 concurrent media-buy lifecycle compatibility partitions/.test(error.message)
    );
    assert.equal(negotiations, 32, 'the rejected partition must fail before lifecycle negotiation');
    assert.equal(disposals, 0, 'a full cache must not dispose a coordinator with an active caller');

    gates.get('concurrent-partition-0')();
    await pending[0];

    const admitted = executeStoryboardTask(
      client,
      'list_products',
      {},
      { mediaBuyLifecycleCompatibility: { principalScope: 'concurrent-partition-32' } }
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(negotiations, 33);
    assert.equal(disposals, 1, 'the inactive least-recently-used coordinator should be evicted');

    for (const [scope, release] of gates) {
      if (scope !== 'concurrent-partition-0') release();
    }
    await Promise.all([...pending.slice(1), admitted]);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(disposedWhileActive, 0);
    assert.equal(disposals, 1);
  });

  test('aborting delayed negotiation suppresses dispatch and safely frees a partition under cache pressure', async () => {
    let releaseDelayedNegotiation;
    const delayedNegotiation = new Promise(resolve => {
      releaseDelayedNegotiation = resolve;
    });
    const activeGates = new Map();
    let negotiations = 0;
    let postAbortDispatches = 0;
    let delayedDisposals = 0;
    const client = {
      negotiateMediaBuyLifecycle: async options => {
        negotiations += 1;
        if (options.principalScope === 'delayed-abort') return delayedNegotiation;
        if (options.principalScope === 'pressure-partition') {
          return { listProducts: async () => ({ success: true, data: { products: [] } }) };
        }
        let release;
        const gate = new Promise(resolve => {
          release = resolve;
        });
        activeGates.set(options.principalScope, release);
        return {
          listProducts: async () => {
            await gate;
            return { success: true, data: { products: [] } };
          },
        };
      },
    };
    const controller = new AbortController();
    const aborted = executeStoryboardTask(
      client,
      'list_products',
      {},
      {
        mediaBuyLifecycleCompatibility: { principalScope: 'delayed-abort' },
        signal: controller.signal,
      }
    );
    controller.abort(new Error('storyboard cancelled'));
    await assert.rejects(aborted, /storyboard cancelled/);

    const active = Array.from({ length: 31 }, (_, index) =>
      executeStoryboardTask(
        client,
        'list_products',
        {},
        { mediaBuyLifecycleCompatibility: { principalScope: `abort-pressure-${index}` } }
      )
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(negotiations, 32);
    await assert.rejects(
      executeStoryboardTask(
        client,
        'list_products',
        {},
        { mediaBuyLifecycleCompatibility: { principalScope: 'pressure-partition' } }
      ),
      error => error?.code === 'CONFIGURATION_ERROR'
    );
    assert.equal(negotiations, 32);

    releaseDelayedNegotiation({
      listProducts: async () => {
        postAbortDispatches += 1;
        return { success: true, data: { products: [] } };
      },
      dispose: () => {
        delayedDisposals += 1;
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(postAbortDispatches, 0, 'abort during negotiation must suppress the later coordinator dispatch');

    const admitted = await executeStoryboardTask(
      client,
      'list_products',
      {},
      { mediaBuyLifecycleCompatibility: { principalScope: 'pressure-partition' } }
    );
    assert.equal(admitted.success, true);
    assert.equal(negotiations, 33);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(delayedDisposals, 1, 'the aborted inactive coordinator should be safely evicted');

    for (const release of activeGates.values()) release();
    await Promise.all(active);
  });

  test('forwards cancellation and retains the compatibility lease until mutation polling settles', async () => {
    let releaseMutationPoll;
    const mutationPoll = new Promise(resolve => {
      releaseMutationPoll = resolve;
    });
    const activeGates = new Map();
    let mutationSignal;
    let pollingSignal;
    let mutationSawAbort = false;
    let pollingSawAbort = false;
    let mutationPollSettled = false;
    let mutationDisposed = 0;
    let disposedBeforePollSettled = 0;
    let negotiations = 0;
    const client = {
      negotiateMediaBuyLifecycle: async options => {
        negotiations += 1;
        if (options.principalScope === 'cancellable-mutation') {
          return {
            requestProposals: async (_request, _inputHandler, taskOptions) => {
              mutationSignal = taskOptions?.signal;
              mutationSignal?.addEventListener('abort', () => {
                mutationSawAbort = true;
              });
              return {
                success: true,
                status: 'submitted',
                submitted: {
                  waitForCompletion: async (_pollInterval, signal) => {
                    pollingSignal = signal;
                    signal?.addEventListener('abort', () => {
                      pollingSawAbort = true;
                    });
                    await mutationPoll;
                    mutationPollSettled = true;
                    return { success: true, status: 'completed', data: { proposals: [] } };
                  },
                },
              };
            },
            dispose: () => {
              mutationDisposed += 1;
              if (!mutationPollSettled) disposedBeforePollSettled += 1;
            },
          };
        }
        if (options.principalScope === 'post-cancel-pressure') {
          return { listProducts: async () => ({ success: true, data: { products: [] } }) };
        }
        let release;
        const gate = new Promise(resolve => {
          release = resolve;
        });
        activeGates.set(options.principalScope, release);
        return {
          listProducts: async () => {
            await gate;
            return { success: true, data: { products: [] } };
          },
        };
      },
    };

    const controller = new AbortController();
    const cancelled = executeStoryboardTask(
      client,
      'request_proposals',
      { brief: 'cancel the official protocol mutation' },
      {
        mediaBuyLifecycleCompatibility: { principalScope: 'cancellable-mutation' },
        signal: controller.signal,
      }
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(mutationSignal, controller.signal, 'the coordinator mutation must receive the storyboard signal');
    assert.notEqual(pollingSignal, controller.signal, 'the task poll also carries its own bounded timeout signal');
    assert.equal(pollingSignal.aborted, false);

    controller.abort(new Error('storyboard mutation cancelled'));
    await assert.rejects(cancelled, /storyboard mutation cancelled/);
    assert.equal(mutationSawAbort, true);
    assert.equal(pollingSawAbort, true);

    const active = Array.from({ length: 31 }, (_, index) =>
      executeStoryboardTask(
        client,
        'list_products',
        {},
        { mediaBuyLifecycleCompatibility: { principalScope: `cancel-pressure-${index}` } }
      )
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(negotiations, 32);
    await assert.rejects(
      executeStoryboardTask(
        client,
        'list_products',
        {},
        { mediaBuyLifecycleCompatibility: { principalScope: 'post-cancel-pressure' } }
      ),
      error => error?.code === 'CONFIGURATION_ERROR'
    );
    assert.equal(mutationDisposed, 0, 'an aborted caller must not make a still-polling coordinator evictable');

    releaseMutationPoll();
    await new Promise(resolve => setImmediate(resolve));
    const admitted = await executeStoryboardTask(
      client,
      'list_products',
      {},
      { mediaBuyLifecycleCompatibility: { principalScope: 'post-cancel-pressure' } }
    );
    assert.equal(admitted.success, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(mutationDisposed, 1);
    assert.equal(disposedBeforePollSettled, 0);

    for (const release of activeGates.values()) release();
    await Promise.all(active);
  });

  test('internally aborts an always-working compatibility poll and releases its cache lease', async t => {
    const pollTimeout = new AbortController();
    t.mock.method(AbortSignal, 'timeout', () => pollTimeout.signal);
    let pollingSignal;
    let pollAborted = false;
    let timedCoordinatorDisposals = 0;
    const client = {
      negotiateMediaBuyLifecycle: async options => {
        if (options.principalScope === 'internally-timed-poll') {
          return {
            requestProposals: async () => ({
              success: true,
              status: 'working',
              submitted: {
                waitForCompletion: async (_interval, signal) => {
                  pollingSignal = signal;
                  await new Promise((_, reject) =>
                    signal.addEventListener(
                      'abort',
                      () => {
                        pollAborted = true;
                        reject(signal.reason);
                      },
                      { once: true }
                    )
                  );
                },
              },
            }),
            dispose: () => {
              timedCoordinatorDisposals += 1;
            },
          };
        }
        return {
          listProducts: async () => ({ success: true, data: { products: [] } }),
          dispose: () => undefined,
        };
      },
    };

    const timed = executeStoryboardTask(
      client,
      'request_proposals',
      { brief: 'bound the compatibility poll' },
      { mediaBuyLifecycleCompatibility: { principalScope: 'internally-timed-poll' } }
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pollingSignal, pollTimeout.signal);
    pollTimeout.abort(new Error('internal storyboard poll timeout'));
    const intermediate = await timed;
    assert.equal(intermediate.success, true);
    assert.equal(pollAborted, true);

    for (let index = 0; index < 32; index += 1) {
      await executeStoryboardTask(
        client,
        'list_products',
        {},
        { mediaBuyLifecycleCompatibility: { principalScope: `post-timeout-${index}` } }
      );
    }
    assert.equal(timedCoordinatorDisposals, 1, 'the settled poll lease must become safely evictable');
  });
});

describe('executeStoryboardTask creative wire selection', () => {
  test('uses the canonical method for an explicit canonical 3.1 request without runner projection policy', async () => {
    const calls = [];
    const params = { ext: { adcp: { creative_wire: 'canonical' } } };
    const result = await executeStoryboardTask(
      {
        getAdcpVersion: () => '3.1.10',
        getProducts: async request => {
          calls.push({ method: 'canonical', request });
          return { data: { products: [], wire: 'canonical' } };
        },
        getProductsLegacy: async request => {
          calls.push({ method: 'legacy', request });
          return { data: { products: [], wire: 'canonical' } };
        },
      },
      'get_products',
      params
    );

    assert.deepEqual(calls, [{ method: 'canonical', request: params }]);
    assert.equal(result.data.wire, 'canonical');
  });

  test('keeps an unhinted 3.1 product request ambiguous for dual-format responses', async () => {
    const calls = [];
    const result = await executeStoryboardTask(
      {
        getAdcpVersion: () => '3.1.10',
        getProducts: async request => {
          calls.push({ method: 'canonical', request });
          return { data: { products: [], wire: 'canonical' } };
        },
        getProductsLegacy: async request => {
          calls.push({ method: 'legacy', request });
          return { data: { products: [], wire: 'legacy' } };
        },
      },
      'get_products',
      {}
    );

    assert.deepEqual(calls, [{ method: 'legacy', request: {} }]);
    assert.equal(result.data.wire, 'legacy');
  });

  test('uses a raw product projection without changing the authored wire', async () => {
    const calls = [];
    const params = { context: { correlation_id: 'dual-format-grading' } };
    const result = await executeStoryboardTask(
      {
        getAdcpVersion: () => '3.1.10',
        getProducts: async request => {
          calls.push({ method: 'canonical', request });
          return { data: { products: [], wire: 'canonical' } };
        },
        getProductsLegacy: async request => {
          calls.push({ method: 'raw', request });
          return { data: { products: [], wire: 'dual' } };
        },
      },
      'get_products',
      params,
      { responseProjection: 'raw' }
    );

    assert.deepEqual(calls, [{ method: 'raw', request: params }]);
    assert.equal(result.data.wire, 'dual');
  });

  for (const [label, formatIds, formatOptions] of [
    ['equivalent', [{ id: 'display', agent_url: 'https://seller.example/' }], [{ format_kind: 'display' }]],
    ['conflicting', [{ id: 'video', agent_url: 'https://seller.example/' }], [{ format_kind: 'audio' }]],
    ['unprojectable', [{ id: 'custom', agent_url: 'https://other.example/' }], undefined],
  ]) {
    test(`preserves ${label} co-present format selector routes at the receiver (#2707)`, async () => {
      const calls = [];
      const pkg = { package_id: 'pkg-1', format_ids: formatIds };
      if (formatOptions) pkg.format_options = formatOptions;
      const params = { packages: [pkg] };

      await executeStoryboardTask(
        {
          getAdcpVersion: () => '3.2.0-beta.8',
          createMediaBuy: async () => {
            throw new Error('canonical projection must not drop an authored legacy route');
          },
          createMediaBuyLegacy: async request => {
            calls.push(request);
            return { data: { media_buy_id: 'mb-1' } };
          },
        },
        'create_media_buy',
        params
      );

      assert.deepStrictEqual(calls, [params]);
      assert.strictEqual(calls[0].ext, undefined, '3.2 requests must not be stamped as legacy wire');
    });
  }

  test('preserves format_ids on update_media_buy new_packages (#2707)', async () => {
    const calls = [];
    const params = {
      media_buy_id: 'mb-1',
      new_packages: [
        {
          package_id: 'pkg-new',
          format_ids: [{ id: 'display', agent_url: 'https://seller.example/' }],
        },
      ],
    };

    await executeStoryboardTask(
      {
        getAdcpVersion: () => '3.2.0-beta.8',
        updateMediaBuy: async () => {
          throw new Error('canonical projection must not drop new_packages format_ids');
        },
        updateMediaBuyLegacy: async request => {
          calls.push(request);
          return { data: { media_buy_id: 'mb-1' } };
        },
      },
      'update_media_buy',
      params
    );

    assert.deepStrictEqual(calls, [params]);
  });
});

describe('executeStoryboardTask creative asset directives', () => {
  test('rejects unexpanded directives before client validation or dispatch', async () => {
    let callCount = 0;
    const result = await executeStoryboardTask(
      {
        syncCreatives: async () => {
          callCount += 1;
          return { data: { creatives: [] } };
        },
      },
      'sync_creatives',
      {
        creatives: [
          {
            assets: {
              $build_assets_from_format: { agent_url: 'https://creative.example', id: 'display_300x250' },
            },
          },
        ],
      }
    );

    assert.equal(callCount, 0);
    assert.deepEqual(result, {
      success: false,
      error:
        "Request contains unexpanded storyboard directive '$build_assets_from_format' at " +
        '$.creatives[0].assets.$build_assets_from_format. ' +
        'Call expandCreativeAssetDirectives(params, context, testKit) before passing params to executeStoryboardTask.',
    });
  });
});
