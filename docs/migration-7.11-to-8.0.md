# Migration Guide: 7.11 to 8.0

## Wholesale Feed Sync Rename

The beta wholesale feed mirror helper was renamed to match the AdCP 3.1 beta 3 protocol language.

```ts
// Before
import { CatalogSync } from '@adcp/sdk/catalog-sync';

// After
import { WholesaleFeedSync } from '@adcp/sdk/wholesale-feed-sync';
```

Type names moved with the class:

| 7.11 beta name | 8.0 name |
| --- | --- |
| `CatalogSync` | `WholesaleFeedSync` |
| `CatalogSyncConfig` | `WholesaleFeedSyncConfig` |
| `CatalogSyncClient` | `WholesaleFeedSyncClient` |
| `CatalogSyncEvents` | `WholesaleFeedSyncEvents` |
| `CatalogSyncMode` | `WholesaleFeedSyncMode` |
| `CatalogSyncState` | `WholesaleFeedSyncState` |

The old `@adcp/sdk/catalog-sync` subpath was removed. Use `@adcp/sdk/wholesale-feed-sync`.

`CursorStore`, `InMemoryCursorStore`, and `FileCursorStore` are still available from the `@adcp/sdk` package root for `RegistrySync` users; they are no longer re-exported from the wholesale feed sync subpath.

The beta-era direct feed polling options were removed from the config shape: `feedOrigin`, `feedHeaders`, `maxFeedResponseBytes`, `pollIntervalMs`, `cursorStore`, and `fetch`. Beta 3 wholesale feed sync uses account-level `notification_configs[]` webhooks plus conditional wholesale reads for repair.

`ResolvedCapabilities.catalogVersioning` was also removed. Use `ResolvedCapabilities.wholesaleFeedVersioning`.

## Current 8.x Beta Follow-up: RFC 9421 Transport Response Verification

This was not part of the original 8.0 beta cut. Generic response verification remains unsupported in the 8.1 beta line because AdCP 3.x does not authorize RFC 9421 §2.2.9 transport response signing as a protocol surface. If you are upgrading from 7.11 directly to the current 8.x beta (`@adcp/sdk@beta`), apply this change along with the rest of the v8 migration.

The SDK keeps signing-only compatibility helpers for adopters that already sign JSON transport responses and publish `adcp_use: 'response-signing'` JWKs: `signResponse`, `signResponseAsync`, `buildResponseSignatureBase`, `ResponseLike`, `ResponseSignatureError`, `RESPONSE_SIGNING_TAG`, `RESPONSE_MANDATORY_COMPONENTS`, `prepareResponseSignature`, `finalizeResponseSignature`, `SignResponseOptions`, `PreparedResponseSignature`, and `SignedResponse`.

Still unsupported:

| Unsupported API | Replacement |
| --- | --- |
| `verifyResponseSignature`, `createResponseVerifier` | None for generic transport responses |
| `VerifyResponseOptions`, `VerifyResponseResult`, `CreateResponseVerifierOptions` | None |

`pemToAdcpJwk({ adcp_use: 'response-signing' })` and `mintEphemeralEd25519Key({ adcp_use: 'response-signing' })` are accepted for this compatibility signing path. `signRequestAsync()` and `signWebhookAsync()` still fail closed when given response-signing keys. `signResponseAsync()` also requires providers to declare `adcpUse: 'response-signing'`; legacy providers that omit `adcpUse` remain accepted by request/webhook helpers but are refused for response signing.

There is no conformant AdCP 3.x replacement for generic transport response verification. Request signing and webhook signing are unchanged. Future designated-task payload JWS support should be added under a fresh spec-defined purpose and helper surface rather than expanding this compatibility signing path.
