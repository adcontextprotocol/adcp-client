[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ProtocolResponseParser

# Class: ProtocolResponseParser

Defined in: [src/lib/core/ProtocolResponseParser.ts:33](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ProtocolResponseParser.ts#L33)

Simple parser that follows ADCP spec exactly

## Constructors

### Constructor

> **new ProtocolResponseParser**(): `ProtocolResponseParser`

#### Returns

`ProtocolResponseParser`

## Methods

### isInputRequest()

> **isInputRequest**(`response`): `boolean`

Defined in: [src/lib/core/ProtocolResponseParser.ts:37](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ProtocolResponseParser.ts#L37)

Check if response indicates input is needed per ADCP spec

#### Parameters

##### response

`any`

#### Returns

`boolean`

***

### parseInputRequest()

> **parseInputRequest**(`response`): [`InputRequest`](../interfaces/InputRequest.md)

Defined in: [src/lib/core/ProtocolResponseParser.ts:55](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ProtocolResponseParser.ts#L55)

Parse input request from response

#### Parameters

##### response

`any`

#### Returns

[`InputRequest`](../interfaces/InputRequest.md)

***

### getStatus()

> **getStatus**(`response`): `null` \| [`ADCPStatus`](../type-aliases/ADCPStatus.md)

Defined in: [src/lib/core/ProtocolResponseParser.ts:74](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ProtocolResponseParser.ts#L74)

Get ADCP status from response

#### Parameters

##### response

`any`

#### Returns

`null` \| [`ADCPStatus`](../type-aliases/ADCPStatus.md)
