[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / SyncCreativesResponse

# Interface: SyncCreativesResponse

Defined in: [src/lib/types/tools.generated.ts:644](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L644)

Response from creative sync operation with detailed results and bulk operation summary

## Properties

### adcp\_version

> **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:648](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L648)

AdCP schema version used for this response

***

### message

> **message**: `string`

Defined in: [src/lib/types/tools.generated.ts:652](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L652)

Human-readable result message summarizing the sync operation

***

### context\_id?

> `optional` **context\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:656](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L656)

Context ID for tracking async operations

***

### dry\_run?

> `optional` **dry\_run**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:660](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L660)

Whether this was a dry run (no actual changes made)

***

### summary

> **summary**: `object`

Defined in: [src/lib/types/tools.generated.ts:664](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L664)

High-level summary of sync operation results

#### total\_processed

> **total\_processed**: `number`

Total number of creatives processed

#### created

> **created**: `number`

Number of new creatives created

#### updated

> **updated**: `number`

Number of existing creatives updated

#### unchanged

> **unchanged**: `number`

Number of creatives that were already up-to-date

#### failed

> **failed**: `number`

Number of creatives that failed validation or processing

#### deleted?

> `optional` **deleted**: `number`

Number of creatives deleted/archived (when delete_missing=true)

***

### results

> **results**: `object`[]

Defined in: [src/lib/types/tools.generated.ts:693](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L693)

Detailed results for each creative processed

#### creative\_id

> **creative\_id**: `string`

Creative ID from the request

#### action

> **action**: `"failed"` \| `"created"` \| `"updated"` \| `"unchanged"` \| `"deleted"`

Action taken for this creative

#### status?

> `optional` **status**: `CreativeStatus`

#### platform\_id?

> `optional` **platform\_id**: `string`

Platform-specific ID assigned to the creative

#### changes?

> `optional` **changes**: `string`[]

List of field names that were modified (for 'updated' action)

#### errors?

> `optional` **errors**: `string`[]

Validation or processing errors (for 'failed' action)

#### warnings?

> `optional` **warnings**: `string`[]

Non-fatal warnings about this creative

#### review\_feedback?

> `optional` **review\_feedback**: `string`

Feedback from platform review process

#### suggested\_adaptations?

> `optional` **suggested\_adaptations**: `object`[]

Recommended creative adaptations for better performance

***

### assignments\_summary?

> `optional` **assignments\_summary**: `object`

Defined in: [src/lib/types/tools.generated.ts:752](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L752)

Summary of assignment operations (when assignments were included in request)

#### total\_assignments\_processed

> **total\_assignments\_processed**: `number`

Total number of creative-package assignment operations processed

#### assigned

> **assigned**: `number`

Number of successful creative-package assignments

#### unassigned

> **unassigned**: `number`

Number of creative-package unassignments

#### failed

> **failed**: `number`

Number of assignment operations that failed

***

### assignment\_results?

> `optional` **assignment\_results**: `object`[]

Defined in: [src/lib/types/tools.generated.ts:773](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L773)

Detailed assignment results (when assignments were included in request)

#### creative\_id

> **creative\_id**: `string`

Creative that was assigned/unassigned

#### assigned\_packages?

> `optional` **assigned\_packages**: `string`[]

Packages successfully assigned to this creative

#### unassigned\_packages?

> `optional` **unassigned\_packages**: `string`[]

Packages successfully unassigned from this creative

#### failed\_packages?

> `optional` **failed\_packages**: `object`[]

Packages that failed to assign/unassign
