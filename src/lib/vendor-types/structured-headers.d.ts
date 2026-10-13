// Keep this declaration aligned with the exact structured-headers version in
// package.json. The package exposes types only through an exports map, which
// legacy Node resolution cannot follow in hoisted source-build layouts.
declare module 'structured-headers' {
  export class Token {
    private readonly value;
    constructor(value: string);
    toString(): string;
  }

  export class DisplayString {
    private readonly value;
    constructor(value: string);
    toString(): string;
  }

  export type BareItem = number | string | Token | ArrayBuffer | Date | boolean | DisplayString;
  export type Parameters = Map<string, BareItem>;
  export type Item = [BareItem, Parameters];
  export type InnerList = [Item[], Parameters];
  export type Dictionary = Map<string, Item | InnerList>;
  export type DictionaryObject = Record<string, BareItem | Item | InnerList>;

  export class ParseError extends Error {
    constructor(position: number, message: string);
  }

  export function parseDictionary(input: string): Dictionary;
  export function serializeDictionary(input: Dictionary | DictionaryObject): string;
  export function serializeItem(input: Item): string;
  export function serializeItem(input: BareItem, params?: Parameters): string;
  export function serializeInnerList(input: InnerList): string;
}
