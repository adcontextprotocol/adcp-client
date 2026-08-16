import { describe, it, expect } from 'vitest';
import { executeStoryboardTask } from './task-map';

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
    expect(receivedParams).toEqual({ ext: { adcp: { creative_wire: 'legacy' } } });
    expect(result.data).toEqual({ products: [], format: 'legacy' });
  });

  it('uses canonical creative methods when grading a 3.2+ wire', async () => {
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
        calls.push('legacy');
        return { data: { products: [] } };
      },
    };

    const result = await executeStoryboardTask(client, 'get_products', {});
    expect(calls).toEqual(['canonical']);
    expect(receivedParams).toEqual({});
    expect(result.data).toEqual({ products: [], format: 'canonical' });
  });

  it('honors an explicit canonical wire request when grading a pre-3.2 storyboard', async () => {
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
        calls.push('legacy');
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
});
