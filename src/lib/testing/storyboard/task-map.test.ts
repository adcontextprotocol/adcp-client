import { describe, it, expect } from 'vitest';
import { executeStoryboardTask } from './task-map';

const INVALID_REQUEST_ERROR = {
  code: 'INVALID_REQUEST',
  message: 'create_media_buy failed: Invalid value for field packages.0.product_id: Field required',
  recovery: 'correctable' as const,
  field: 'packages.0.product_id',
  details: { validation_errors: [{ field: 'packages.0.product_id', message: 'Field required' }] },
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

  it('omits adcp_error when the task result has no adcpError', async () => {
    const client = makeFailureClient(undefined);
    const result = await executeStoryboardTask(client, 'create_media_buy', {});

    expect(result.adcp_error).toBeUndefined();
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
});
