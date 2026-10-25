import { AdcpError } from '../../server/decisioning/async-outcome';
import { getToolSchemaDocument } from '../../validation/schema-loader';
import { resolveAdcpVersion } from '../../utils/adcp-version-config';
import { ADCP_VERSION, toReleasePrecisionVersion } from '../../version';

/** Preserve the selected reporting contract when helpers are used outside the framework dispatcher. */
export function withReportingResponseVersion<TRequest, TContext, TResponse extends object>(
  tool: 'get_reporting_status' | 'sync_reporting_status',
  handler: (request: TRequest, context: TContext) => Promise<TResponse>
): (request: TRequest, context: TContext) => Promise<TResponse> {
  return async (request, context) => {
    const served = (context as { servedAdcpVersion?: unknown } | null)?.servedAdcpVersion;
    const requested = (request as { adcp_version?: unknown } | null)?.adcp_version;
    const candidate = typeof served === 'string' ? served : typeof requested === 'string' ? requested : ADCP_VERSION;
    let version: string;
    try {
      version = resolveAdcpVersion(candidate);
      if (!getToolSchemaDocument(tool, 'request', version)) throw new Error('Unavailable reporting contract');
    } catch {
      throw new AdcpError('VERSION_UNSUPPORTED', { message: 'The selected AdCP reporting contract is unavailable.' });
    }
    const response = await handler(request, context);
    return { ...response, adcp_version: toReleasePrecisionVersion(version) };
  };
}
