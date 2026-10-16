import { getSchemaValidatorByRef } from '../../validation/schema-loader';

/**
 * Validator for one reporting delivery offering, built from the installed AdCP bundle's
 * `core/reporting-delivery-offering.json`. Returns `undefined` when the installed bundle cannot
 * validate offerings, so a caller can refuse to publish a capability it cannot check.
 *
 * Storage packages use this to hold a managed-delivery runtime to the same offering contract the
 * protocol layer enforces.
 */
export function getReportingDeliveryOfferingValidatorV1(): ((offering: unknown) => boolean) | undefined {
  const validate = getSchemaValidatorByRef('core/reporting-delivery-offering.json');
  return validate ? offering => Boolean(validate(offering)) : undefined;
}
