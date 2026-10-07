// A type-fest 4 shape: type aliases whose type parameters carry constraints and defaults
// (`ArraySlice<Array_ extends readonly unknown[], Start extends number = never, ...>`,
// `CamelCase<Type, Options extends CamelCaseOptions = {}>` over a template literal type).
export type CamelCaseOptions = { preserveConsecutiveUppercase?: boolean };

export type CamelCase<Type, Options extends CamelCaseOptions = {}> = Type extends string
  ? `${Options['preserveConsecutiveUppercase'] extends true ? Type : Lowercase<Type>}`
  : Type;

export type Slice<
  Array_ extends readonly unknown[],
  Start extends number = never,
  End extends number = never,
> = Array_ extends unknown ? ([Start] extends [never] ? Array_ : Array_[number][]) : never;
