/** Consent helper semantics from the AdCP 3.3 translation contract. */
const VENDOR_SCOPED_CONSENT_MACRO = /^\{GDPR_CONSENT_[1-9][0-9]*\}$/;

const CONSENT_MACROS = new Set<string>([
  '{GDPR}',
  '{GDPR_CONSENT}',
  '{ADDTL_CONSENT}',
  '{US_PRIVACY}',
  '{GPP_STRING}',
  '{GPP_SID}',
  '{LIMIT_AD_TRACKING}',
]);

/** The complete token retains the receiving vendor's positive decimal GVL ID. */
export function isVendorScopedConsentMacro(token: string): boolean {
  return VENDOR_SCOPED_CONSENT_MACRO.test(token);
}

/** Recognize privacy signals for helper compilation and consent diagnostics. */
export function isConsentMacro(token: string): boolean {
  return CONSENT_MACROS.has(token) || isVendorScopedConsentMacro(token);
}
