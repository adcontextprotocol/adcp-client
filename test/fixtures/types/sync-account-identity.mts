import type { AccountStore, SyncAccountsResultRow } from '@adcp/sdk/server';

const settings = {
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
} satisfies SyncAccountsResultRow;
const upsert: NonNullable<AccountStore['upsert']> = async () => [settings];
const failed = {
  account: { account_id: 'unreachable-account' },
  action: 'failed',
  errors: [{ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' }],
} satisfies SyncAccountsResultRow;
// @ts-expect-error Successful rows require lifecycle status.
const noStatus: SyncAccountsResultRow = { account: settings.account, action: 'updated' };
// @ts-expect-error The response cannot contain the request-only destination entity.
const writeOnly: SyncAccountsResultRow = { ...settings, destination_billing_entity: { legal_name: 'Confidential' } };
void [upsert, failed, noStatus, writeOnly];
