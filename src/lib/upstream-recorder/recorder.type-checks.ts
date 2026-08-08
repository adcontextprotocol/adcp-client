import { computePayloadDigestSha256 } from './recorder';

computePayloadDigestSha256({ authorization: 'secret' }, 'application/json', {
  redactPattern: /authorization/i,
});
computePayloadDigestSha256({ authorization: '[redacted]' }, 'application/json', {
  prenormalized: true,
});

// @ts-expect-error Bare RegExp options were removed in v13; use { redactPattern }.
computePayloadDigestSha256({ authorization: 'secret' }, 'application/json', /authorization/i);

// @ts-expect-error The false sentinel was removed in v13; use { prenormalized: true }.
computePayloadDigestSha256({ authorization: '[redacted]' }, 'application/json', false);
