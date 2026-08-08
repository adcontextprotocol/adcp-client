// Keep this declaration aligned with the exact structured-headers version in
// package.json. The package exposes types only through an exports map, which
// legacy Node resolution cannot follow in hoisted source-build layouts.
declare module 'structured-headers' {
  class Token {
    private readonly value;
    constructor(value: string);
    toString(): string;
  }

  class DisplayString {
    private readonly value;
    constructor(value: string);
    toString(): string;
  }

  type BareItem = number | string | Token | ArrayBuffer | Date | boolean | DisplayString;
  type Parameters = Map<string, BareItem>;
  type Item = [BareItem, Parameters];
  export type InnerList = [Item[], Parameters];
  type Dictionary = Map<string, Item | InnerList>;

  export class ParseError extends Error {
    constructor(position: number, message: string);
  }

  export function parseDictionary(input: string): Dictionary;
  export function serializeInnerList(input: InnerList): string;
}
