/**
 * Experimental AdCP 3.3 trust records, origin bindings, and demand-side
 * grants. Evaluated only at binding, grants, and `open` onboarding; never on
 * the signature path.
 */
export {
  TRUST_RECORD_PATH,
  TRUST_RECORD_MAX_BYTES,
  TrustRecordAbsentError,
  TrustRecordError,
  TrustRecordEvaluator,
  TrustRecordMatchError,
  fetchTrustRecord,
  isPrivateSuffixOperator,
  matchTrustRecordAgent,
  operatorDomainOf,
  trustRecordUrl,
  validateTrustRecord,
  type EvaluatedTrustRecord,
  type TrustRecordEvaluatorOptions,
  type TrustRecordFetcher,
  type TrustRecordResponse,
} from './record';
export {
  GRANT_ABSENT_DETAILS,
  TrustGrantEvaluator,
  trustRecordUnavailableError,
  grantAbsentError,
  requireGrant,
  type GrantAuthorization,
  type GrantRequest,
  type TrustGrantCheck,
  type TrustGrantEvaluatorOptions,
} from './grants';
export {
  OriginBindingError,
  OriginBindings,
  type BindOriginOptions,
  type OriginBindingResolver,
  type OriginBindingStore,
} from './bindings';
export { identityPreviewSchemaErrors, type IdentityPreviewSchema } from './schema';
