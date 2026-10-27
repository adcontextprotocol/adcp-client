import type { SyncAccountsResultRow } from '../lib/server/decisioning';
import { toWireSyncAccountRow } from '../lib/server/decisioning/account';

const settings: SyncAccountsResultRow = {
  account: { account_id: 'account-3466' },
  operator_unit: { id: 'current-seat' },
  revision: 3,
  identity_change: {
    status: 'pending_approval',
    requested_operator_identity: { operator: 'destination.example' },
  },
  currency: 'EUR',
  timezone: 'Europe/Berlin',
  action: 'updated',
  status: 'active',
};
const preview: SyncAccountsResultRow = {
  ...settings,
  identity_change: undefined,
  identity_change_preview: {
    outcome: 'would_require_approval',
    requested_operator_identity: { operator: 'destination.example' },
    impacts: [{ area: 'billing', effect: 'revalidation_required' }],
  },
};
const failed: SyncAccountsResultRow = {
  account: { account_id: 'unreachable-account' },
  action: 'failed',
  errors: [{ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' }],
};
const writeOnly: SyncAccountsResultRow = {
  ...settings,
  // @ts-expect-error The entire staging field is request-only, including its legal name.
  destination_billing_entity: { legal_name: 'Confidential Destination GmbH' },
};
void [toWireSyncAccountRow(settings), toWireSyncAccountRow(preview), toWireSyncAccountRow(failed), writeOnly];

// @ts-expect-error Successful results require lifecycle status.
const noStatus: SyncAccountsResultRow = { account: { account_id: 'account-3466' }, action: 'updated' };
// @ts-expect-error A result needs an account reference or a complete natural key.
const noIdentity: SyncAccountsResultRow = { action: 'updated', status: 'active' };
// @ts-expect-error Settings-update results must not carry both identity anchors.
const bothIdentities: SyncAccountsResultRow = {
  ...settings,
  brand: { domain: 'brand.example' },
  operator: 'agency.example',
};
void [noStatus, noIdentity, bothIdentities];
