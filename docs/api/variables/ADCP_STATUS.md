[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ADCP\_STATUS

# Variable: ADCP\_STATUS

> `const` **ADCP\_STATUS**: `object`

Defined in: [src/lib/core/ProtocolResponseParser.ts:16](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ProtocolResponseParser.ts#L16)

ADCP standardized status values as per spec PR #78
Clear semantics for async task management:
- submitted: Long-running tasks (hours to days) - webhook required
- working: Processing tasks (<120 seconds) - keep connection open
- input-required: Tasks needing user interaction via handler
- completed: Successful task completion

## Type Declaration

### SUBMITTED

> `readonly` **SUBMITTED**: `"submitted"` = `'submitted'`

### WORKING

> `readonly` **WORKING**: `"working"` = `'working'`

### INPUT\_REQUIRED

> `readonly` **INPUT\_REQUIRED**: `"input-required"` = `'input-required'`

### COMPLETED

> `readonly` **COMPLETED**: `"completed"` = `'completed'`

### FAILED

> `readonly` **FAILED**: `"failed"` = `'failed'`

### CANCELED

> `readonly` **CANCELED**: `"canceled"` = `'canceled'`

### REJECTED

> `readonly` **REJECTED**: `"rejected"` = `'rejected'`

### AUTH\_REQUIRED

> `readonly` **AUTH\_REQUIRED**: `"auth-required"` = `'auth-required'`

### UNKNOWN

> `readonly` **UNKNOWN**: `"unknown"` = `'unknown'`
