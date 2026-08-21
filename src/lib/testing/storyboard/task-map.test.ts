import { describe, it, expect } from 'vitest';
import { TASK_TO_METHOD, defaultStoryboardResponseProjection, executeStoryboardTask } from './task-map';

const INVALID_REQUEST_ERROR = {
  code: 'INVALID_REQUEST',
  message: 'create_media_buy failed: Invalid value for field packages.0.product_id: Field required',
  recovery: 'correctable' as const,
  field: 'packages.0.product_id',
  details: { validation_errors: [{ field: 'packages.0.product_id', message: 'Field required' }] },
};

const MULTI_FINALIZE_FAILED_PAYLOAD = {
  products: [],
  proposals: [],
  errors: [
    {
      code: 'MULTI_FINALIZE_UNSUPPORTED',
      message:
        'Atomic multi-proposal finalize is not supported; sequence individual create_media_buy(proposal_id=...) calls instead.',
      field: 'refine',
      recovery: 'correctable',
    },
  ],
  adcp_version: '3.1',
  status: 'failed',
};

const ADVISORY_ERROR = {
  code: 'NON_BLOCKING_DIAGNOSTIC',
  message: 'Advisory warning',
};

function makeFailureClient(adcpError?: object) {
  return {
    createMediaBuy: async () => ({
      success: false,
      status: 'failed',
      error: `${INVALID_REQUEST_ERROR.code}: ${INVALID_REQUEST_ERROR.message}`,
      data: { adcp_error: INVALID_REQUEST_ERROR },
      adcpError,
    }),
  };
}

describe('executeStoryboardTask — adcp_error forwarding', () => {
  it('routes every compact 3.2 lifecycle step through its public SDK buyer wrapper', async () => {
    const compactMethods = {
      list_products: 'listProducts',
      request_proposals: 'requestProposals',
      refine_proposals: 'refineProposals',
      decline_proposals: 'declineProposals',
      buy_products: 'buyProducts',
      accept_proposal: 'acceptProposal',
      control_media_buy: 'controlMediaBuy',
    } as const;
    const calls: Array<{ method: string; params: unknown }> = [];
    const client: Record<string, unknown> = {
      executeTask: async () => {
        throw new Error('compact lifecycle steps must not bypass the public buyer wrappers');
      },
    };
    for (const method of Object.values(compactMethods)) {
      client[method] = async (params: unknown) => {
        calls.push({ method, params });
        return { success: true, data: { method } };
      };
    }

    for (const [task, method] of Object.entries(compactMethods)) {
      expect(TASK_TO_METHOD[task]).toBe(method);
      const params = { compact_marker: task };
      const result = await executeStoryboardTask(client, task, params);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ method });
    }

    expect(calls).toEqual(
      Object.entries(compactMethods).map(([task, method]) => ({
        method,
        params: { compact_marker: task },
      }))
    );
  });

  it('can route compact storyboard steps through one negotiated compatibility coordinator', async () => {
    const calls: unknown[] = [];
    const coordinator = {
      listProducts: async (params: unknown) => {
        calls.push(params);
        return { success: true, data: { products: [] } };
      },
    };
    const client = {
      negotiateMediaBuyLifecycle: async (options: unknown) => {
        calls.push(options);
        return coordinator;
      },
      listProducts: async () => {
        throw new Error('compatibility mode must not dispatch the native wrapper directly');
      },
    };
    const compatibility = {
      allowedLosses: ['feed_version_not_atomic'] as const,
    };

    const first = await executeStoryboardTask(
      client,
      'list_products',
      { max_results: 5 },
      {
        mediaBuyLifecycleCompatibility: compatibility,
      }
    );
    const second = await executeStoryboardTask(
      client,
      'list_products',
      {},
      {
        mediaBuyLifecycleCompatibility: compatibility,
      }
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(calls).toEqual([compatibility, { max_results: 5 }, {}]);
  });

  it('evicts a failed compatibility negotiation so a later attempt can recover', async () => {
    let negotiations = 0;
    const client = {
      negotiateMediaBuyLifecycle: async () => {
        negotiations += 1;
        if (negotiations === 1) throw new Error('temporary discovery failure');
        return {
          listProducts: async () => ({ success: true, data: { products: [] } }),
        };
      },
    };
    const options = { mediaBuyLifecycleCompatibility: {} };

    await expect(executeStoryboardTask(client, 'list_products', {}, options)).rejects.toThrow(
      'temporary discovery failure'
    );
    const recovered = await executeStoryboardTask(client, 'list_products', {}, options);

    expect(recovered.success).toBe(true);
    expect(negotiations).toBe(2);
  });

  it('uses raw legacy creative methods when grading a pre-3.2 wire', async () => {
    const calls: string[] = [];
    let receivedParams: unknown;
    const client = {
      getAdcpVersion: () => '3.1.2',
      getProducts: async () => {
        calls.push('canonical');
        return { data: { products: [] } };
      },
      getProductsLegacy: async (params: unknown) => {
        calls.push('legacy');
        receivedParams = params;
        return { data: { products: [], format: 'legacy' } };
      },
    };

    const result = await executeStoryboardTask(client, 'get_products', {});
    expect(calls).toEqual(['legacy']);
    expect(receivedParams).toEqual({});
    expect(result.data).toEqual({ products: [], format: 'legacy' });
  });

  it('retains explicit legacy wire routing for media-buy lifecycle tasks', async () => {
    let receivedParams: unknown;
    const client = {
      getAdcpVersion: () => '3.1.13',
      createMediaBuyLegacy: async (params: unknown) => {
        receivedParams = params;
        return { data: { media_buy_id: 'buy_1' } };
      },
    };

    await executeStoryboardTask(client, 'create_media_buy', { packages: [] });
    expect(receivedParams).toEqual({
      packages: [],
      ext: { adcp: { creative_wire: 'legacy' } },
    });
  });

  it('routes get_media_buys through raw execution with the legacy wire hint', async () => {
    let receivedTask: string | undefined;
    let receivedParams: unknown;
    const client = {
      getAdcpVersion: () => '3.1.13',
      getMediaBuys: async () => {
        throw new Error('canonical method must not be selected');
      },
      executeTask: async (task: string, params: unknown) => {
        receivedTask = task;
        receivedParams = params;
        return { data: { media_buys: [] } };
      },
    };

    await executeStoryboardTask(client, 'get_media_buys', {});
    expect(receivedTask).toBe('get_media_buys');
    expect(receivedParams).toEqual({ ext: { adcp: { creative_wire: 'legacy' } } });
  });

  it('uses canonical creative methods when called without runner projection policy on a 3.2+ wire', async () => {
    const calls: string[] = [];
    let receivedParams: unknown;
    const client = {
      getAdcpVersion: () => '3.2',
      getProducts: async (params: unknown) => {
        calls.push('canonical');
        receivedParams = params;
        return { data: { products: [], format: 'canonical' } };
      },
      getProductsLegacy: async () => {
        calls.push('raw');
        return { data: { products: [] } };
      },
    };

    const result = await executeStoryboardTask(client, 'get_products', {});
    expect(calls).toEqual(['canonical']);
    expect(receivedParams).toEqual({});
    expect(result.data).toEqual({ products: [], format: 'canonical' });
  });

  it('honors an explicit canonical wire request when called without runner projection policy', async () => {
    const calls: string[] = [];
    let receivedParams: unknown;
    const params = {
      ext: { adcp: { creative_wire: 'canonical', storyboard_marker: true } },
    };
    const client = {
      getAdcpVersion: () => '3.1.10',
      getProducts: async (request: unknown) => {
        calls.push('canonical');
        receivedParams = request;
        return { data: { products: [], format: 'canonical' } };
      },
      getProductsLegacy: async () => {
        calls.push('raw');
        return { data: { products: [], format: 'legacy' } };
      },
    };

    const result = await executeStoryboardTask(client, 'get_products', params);
    expect(calls).toEqual(['canonical']);
    expect(receivedParams).toBe(params);
    expect(result.data).toEqual({ products: [], format: 'canonical' });
  });

  it('uses the raw product projection without changing an unhinted request', async () => {
    const calls: string[] = [];
    let receivedParams: unknown;
    const params = { context: { correlation_id: 'dual-format-grading' } };
    const client = {
      getAdcpVersion: () => '3.1.10',
      getProducts: async () => {
        calls.push('canonical');
        return { data: { products: [] } };
      },
      getProductsLegacy: async (request: unknown) => {
        calls.push('raw');
        receivedParams = request;
        return { data: { products: [], format: 'dual' } };
      },
    };

    const result = await executeStoryboardTask(client, 'get_products', params, { responseProjection: 'raw' });
    expect(calls).toEqual(['raw']);
    expect(receivedParams).toBe(params);
    expect(result.data).toEqual({ products: [], format: 'dual' });
  });

  it('forwards adcpError from a TaskResultFailure into adcp_error', async () => {
    const client = makeFailureClient(INVALID_REQUEST_ERROR);
    const result = await executeStoryboardTask(client, 'create_media_buy', {});

    expect(result.success).toBe(false);
    expect(result.error).toBe(`${INVALID_REQUEST_ERROR.code}: ${INVALID_REQUEST_ERROR.message}`);
    expect(result.adcp_error).toEqual(INVALID_REQUEST_ERROR);
    expect(result.adcp_error?.field).toBe('packages.0.product_id');
    expect(result.adcp_error?.details?.validation_errors).toHaveLength(1);
  });

  it('step.error is JSON-serializable and carries the error message on failure', async () => {
    const client = makeFailureClient(INVALID_REQUEST_ERROR);
    const result = await executeStoryboardTask(client, 'create_media_buy', {});

    // Serialization contract: error must round-trip through JSON as a non-empty string
    const serialized = JSON.parse(JSON.stringify({ error: result.error }));
    expect(typeof serialized.error).toBe('string');
    expect(serialized.error).not.toBe('');
    expect(serialized.error).toContain('INVALID_REQUEST');
  });

  it('adcp_error is JSON-serializable and does not collapse to {}', async () => {
    const client = makeFailureClient(INVALID_REQUEST_ERROR);
    const result = await executeStoryboardTask(client, 'create_media_buy', {});

    // Regression for #1679: adcp_error must not serialize as an empty object
    const serialized = JSON.parse(JSON.stringify({ adcp_error: result.adcp_error }));
    expect(serialized.adcp_error).not.toEqual({});
    expect(serialized.adcp_error.code).toBe('INVALID_REQUEST');
    expect(serialized.adcp_error.field).toBe('packages.0.product_id');
  });

  it('falls back to data.adcp_error when the task result has no adcpError property', async () => {
    const client = makeFailureClient(undefined);
    const result = await executeStoryboardTask(client, 'create_media_buy', {});

    expect(result.adcp_error).toEqual(INVALID_REQUEST_ERROR);
  });

  it('falls back to executeTask for unknown task names', async () => {
    const client = {
      executeTask: async (_name: string, _params: unknown) => ({
        success: false,
        status: 'failed',
        error: 'UNKNOWN_ERROR: bad request',
        data: null,
        adcpError: { code: 'UNKNOWN_ERROR', message: 'bad request' },
      }),
    };
    const result = await executeStoryboardTask(client, 'unknown_task', {});
    expect(result.adcp_error?.code).toBe('UNKNOWN_ERROR');
  });

  it('infers failure from a failed AdCP payload when TaskResult.success is omitted', async () => {
    const client = {
      getProducts: async () => ({
        data: MULTI_FINALIZE_FAILED_PAYLOAD,
      }),
    };

    const result = await executeStoryboardTask(client, 'get_products', {});

    expect(result.success).toBe(false);
    expect(result.data).toEqual(MULTI_FINALIZE_FAILED_PAYLOAD);
  });

  it('uses canonical terminal AdCP error detection when TaskResult.success is omitted', async () => {
    const cases = [
      { name: 'rejected status', data: { status: 'rejected' } },
      { name: 'failed status', data: { status: 'failed' } },
      { name: 'errors without success payload', data: { status: 'completed', errors: [ADVISORY_ERROR] } },
    ];

    for (const testCase of cases) {
      const client = {
        getProducts: async () => ({ data: testCase.data }),
      };

      const result = await executeStoryboardTask(client, 'get_products', {});

      expect(result.success, testCase.name).toBe(false);
    }
  });

  it('treats a raw get_products structured rejection as a successful business outcome', async () => {
    const rejection = {
      status: 'rejected',
      reason: 'No inventory matches the requested brief',
      suggestions: ['Try broadening the requested geography'],
    };
    const client = {
      getAdcpVersion: () => '3.2.0-beta.4',
      getProducts: async () => rejection,
    };

    const result = await executeStoryboardTask(client, 'get_products', {});

    expect(result.success).toBe(true);
    expect(result.data).toEqual(rejection);
    expect(result.data).not.toHaveProperty('products');
  });

  it('preserves a completed get_products structured rejection for storyboard validations', async () => {
    const rejection = {
      status: 'rejected',
      reason: 'No inventory matches the requested brief',
      suggestions: ['Try broadening the requested geography'],
    };
    const client = {
      getAdcpVersion: () => '3.2.0-beta.4',
      getProducts: async () => ({ success: true, status: 'completed', data: rejection }),
    };

    const result = await executeStoryboardTask(client, 'get_products', {});

    expect(result.success).toBe(true);
    expect(result.data).toEqual(rejection);
    expect(result.data).not.toHaveProperty('products');
  });

  it('keeps a bare get_products rejected status classified as a failure', async () => {
    const client = {
      getProducts: async () => ({ status: 'rejected' }),
    };

    const result = await executeStoryboardTask(client, 'get_products', {});

    expect(result.success).toBe(false);
  });

  it('does not treat advisory errors on a success payload as failure', async () => {
    const client = {
      getProducts: async () => ({
        data: { status: 'completed', products: [], errors: [ADVISORY_ERROR] },
      }),
    };

    const result = await executeStoryboardTask(client, 'get_products', {});

    expect(result.success).toBe(true);
  });

  it('forwards top-level adcp_error from a TaskResult when adcpError is absent', async () => {
    const client = {
      getProducts: async () => ({
        adcp_error: INVALID_REQUEST_ERROR,
      }),
    };

    const result = await executeStoryboardTask(client, 'get_products', {});

    expect(result.success).toBe(false);
    expect(result.adcp_error).toEqual(INVALID_REQUEST_ERROR);
  });

  it('defaults schema-compliance get_products steps to raw evidence only', () => {
    expect(defaultStoryboardResponseProjection('get_products', 'schema_compliance')).toBe('raw');
    expect(defaultStoryboardResponseProjection('get_products', 'full_sales_flow')).toBeUndefined();
    expect(defaultStoryboardResponseProjection('get_products', undefined)).toBeUndefined();
    expect(defaultStoryboardResponseProjection('create_media_buy', 'schema_compliance')).toBeUndefined();
  });
});
