/**
 * Which callers a report definition's `contract_version` may be served to.
 *
 * `core/reporting-report-definition.json` `x-adcp-validation.package_dimension`
 * (adcontextprotocol/adcp#8983): callers pinned below AdCP 3.3 accept only 1.0 and 1.1
 * definitions, so a seller MUST serve them offerings whose definitions are 1.0 or 1.1; a 1.2
 * offering serves 3.3 callers only. The comparison is by `MAJOR.MINOR`, so every 3.3 prerelease is
 * a 3.3 caller. A request with no served release, or one this SDK cannot parse, is the SDK's pinned
 * release, as in the Python SDK.
 */
import { AdcpError } from './decisioning/async-outcome';
import { parseAdcpRelease } from '../adapters/version/negotiate';

/** A report definition's `contract_version`. */
export type ReportDefinitionContractVersionV1 = '1.0' | '1.1' | '1.2';

export const REPORT_DEFINITION_CONTRACT_VERSIONS_V1: readonly ReportDefinitionContractVersionV1[] = Object.freeze([
  '1.0',
  '1.1',
  '1.2',
]);

/** Whether a caller served this release accepts a `contract_version` 1.2 report definition. */
export function acceptsReportDefinition12(servedAdcpVersion: string | undefined): boolean {
  if (servedAdcpVersion === undefined) return true;
  const release = parseAdcpRelease(servedAdcpVersion);
  if (release === undefined) return true;
  return release.major > 3 || (release.major === 3 && release.minor >= 3);
}

/**
 * The refusal for a caller pinned below AdCP 3.3 whose reporting delivery configuration names an
 * offering this seller serves to 3.3 callers only. The offering was never advertised to that
 * caller, so the request is outside what it was offered.
 */
export function reportingOfferingRequiresAdcp33Error(offeringId: string, deliveryConfigId?: string): AdcpError {
  return new AdcpError('UNSUPPORTED_FEATURE', {
    recovery: 'correctable',
    field: 'reporting_delivery_configs',
    message:
      `Reporting offering ${JSON.stringify(offeringId)} serves AdCP 3.3 callers only: its report definition ` +
      'is at contract_version 1.2. Choose an offering from get_adcp_capabilities.',
    details: {
      offering_id: offeringId,
      ...(deliveryConfigId !== undefined ? { delivery_config_id: deliveryConfigId } : {}),
    },
  });
}
